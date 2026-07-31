import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { dirname } from "node:path";
import { systemClock, type Clock } from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { blobPath } from "./paths.js";
import { blobRefs, blobs, INLINE_MAX_BYTES } from "./schema.js";

export type BlobEncoding = "utf8" | "binary";

export interface PutOptions {
  /** What this content is: "assembled_content", "transcript_part", "diff", … */
  readonly kind: string;
  readonly encoding?: BlobEncoding;
}

export interface StoredBlob {
  readonly id: string;
  readonly hash: string;
  readonly size: number;
  readonly external: boolean;
  /** True when an identical blob already existed and was reused. */
  readonly deduped: boolean;
}

export interface BlobRef {
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly pinned?: boolean;
}

export class BlobReleasedError extends Error {
  constructor(readonly hash: string) {
    super(`blob ${hash} was released and must be reloaded from its source`);
    this.name = "BlobReleasedError";
  }
}

/**
 * One API over two storage paths (spec §12, §3.2, §6.1).
 *
 * Small content lives inline in the row; content larger than
 * INLINE_MAX_BYTES spills to a content-addressed file. Identical content is
 * stored once — assembled run content repeats heavily across runs (§4.4).
 */
export class BlobStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  put(content: string | Uint8Array, options: PutOptions): StoredBlob {
    const encoding: BlobEncoding =
      options.encoding ?? (typeof content === "string" ? "utf8" : "binary");
    const bytes =
      typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const hash = createHash("sha256").update(bytes).digest("hex");

    const existing = this.state.db
      .select()
      .from(blobs)
      .where(eq(blobs.hash, hash))
      .get();

    if (existing) {
      // A previously released blob is restored by re-putting its content.
      if (existing.releasedAt !== null) this.restore(existing.hash, bytes);

      return {
        id: existing.id,
        hash,
        size: existing.size,
        external: existing.isExternal,
        deduped: true,
      };
    }

    const external = bytes.byteLength > INLINE_MAX_BYTES;
    const id = `blob_${randomUUID()}`;

    if (external) this.writeExternal(hash, bytes);

    this.state.db
      .insert(blobs)
      .values({
        id,
        hash,
        size: bytes.byteLength,
        encoding,
        kind: options.kind,
        inlineBytes: external ? null : Buffer.from(bytes),
        isExternal: external,
      })
      .run();

    return { id, hash, size: bytes.byteLength, external, deduped: false };
  }

  get(id: string): Uint8Array {
    const row = this.state.db
      .select()
      .from(blobs)
      .where(eq(blobs.id, id))
      .get();
    if (!row) throw new Error(`unknown blob ${id}`);
    if (row.releasedAt !== null) throw new BlobReleasedError(row.hash);

    if (row.isExternal) {
      return readFileSync(blobPath(this.state.layout.blobsDir, row.hash));
    }

    if (!row.inlineBytes) throw new Error(`blob ${id} has no bytes`);
    return row.inlineBytes;
  }

  text(id: string): string {
    return Buffer.from(this.get(id)).toString("utf8");
  }

  /** Add a reference, which is what keeps a blob from being compacted. */
  reference(blobId: string, ref: BlobRef): void {
    this.state.db
      .insert(blobRefs)
      .values({
        blobId,
        ownerKind: ref.ownerKind,
        ownerId: ref.ownerId,
        pinned: ref.pinned ?? false,
      })
      .onConflictDoUpdate({
        target: [blobRefs.blobId, blobRefs.ownerKind, blobRefs.ownerId],
        set: { pinned: ref.pinned ?? false },
      })
      .run();
  }

  dereference(blobId: string, ref: Omit<BlobRef, "pinned">): void {
    this.state.db
      .delete(blobRefs)
      .where(
        and(
          eq(blobRefs.blobId, blobId),
          eq(blobRefs.ownerKind, ref.ownerKind),
          eq(blobRefs.ownerId, ref.ownerId),
        ),
      )
      .run();
  }

  /**
   * Spec §6.1: release the bytes of a large blob, keeping the row so the
   * transcript can draw a marker and reload later. Never used on inline
   * content — releasing 64KB buys nothing.
   */
  release(id: string): boolean {
    const row = this.state.db
      .select()
      .from(blobs)
      .where(eq(blobs.id, id))
      .get();
    if (!row || !row.isExternal || row.releasedAt !== null) return false;

    rmSync(blobPath(this.state.layout.blobsDir, row.hash), { force: true });

    this.state.db
      .update(blobs)
      .set({ isExternal: false, releasedAt: this.now() })
      .where(eq(blobs.id, id))
      .run();

    return true;
  }

  /** Candidates for release, largest first (§6.1 releases the largest). */
  releaseCandidates(ownerKind: string, ownerId: string, limit = 10) {
    return this.state.db
      .select({ id: blobs.id, size: blobs.size })
      .from(blobs)
      .innerJoin(blobRefs, eq(blobRefs.blobId, blobs.id))
      .where(
        and(
          eq(blobRefs.ownerKind, ownerKind),
          eq(blobRefs.ownerId, ownerId),
          eq(blobs.isExternal, true),
          isNull(blobs.releasedAt),
        ),
      )
      .orderBy(sql`${blobs.size} DESC`)
      .limit(limit)
      .all();
  }

  /**
   * Compaction: remove unreferenced blobs and their files. Anything with a
   * reference is retained, pinned or not — the retention rule (§3.2) decides
   * which references to drop; this only removes what nothing points at.
   */
  compact(): { removed: number; bytesFreed: number } {
    const referenced = this.state.db
      .selectDistinct({ blobId: blobRefs.blobId })
      .from(blobRefs)
      .all()
      .map((row) => row.blobId);

    const orphans = this.state.db
      .select({ id: blobs.id, hash: blobs.hash, size: blobs.size })
      .from(blobs)
      .where(
        referenced.length > 0 ? notInArray(blobs.id, referenced) : sql`1 = 1`,
      )
      .all();

    let bytesFreed = 0;

    for (const orphan of orphans) {
      rmSync(blobPath(this.state.layout.blobsDir, orphan.hash), {
        force: true,
      });
      this.state.db.delete(blobs).where(eq(blobs.id, orphan.id)).run();
      bytesFreed += orphan.size;
    }

    return { removed: orphans.length, bytesFreed };
  }

  private writeExternal(hash: string, bytes: Uint8Array): void {
    const path = blobPath(this.state.layout.blobsDir, hash);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  private restore(hash: string, bytes: Uint8Array): void {
    const external = bytes.byteLength > INLINE_MAX_BYTES;
    if (external) this.writeExternal(hash, bytes);

    this.state.db
      .update(blobs)
      .set({
        releasedAt: null,
        isExternal: external,
        inlineBytes: external ? null : Buffer.from(bytes),
      })
      .where(eq(blobs.hash, hash))
      .run();
  }
}
