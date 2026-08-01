import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  chooseDelta,
  isCompactable,
  newObjectId,
  newVersionId,
  systemClock,
  DEFAULT_COMPACTION_POLICY,
  type Clock,
  type CompactionPolicy,
  type ContentDelta,
  type ExternalIdentity,
  type ObjectKind,
  type ObjectVersion,
  type Renderings,
} from "@plotroom/core";
import { BlobStore } from "./blob-store.js";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import {
  objectVersions,
  objects,
  type ObjectRow,
  type ObjectVersionRow,
} from "./schema.js";

export interface WriteObjectInput {
  readonly kind: ObjectKind;
  readonly title: string;
  readonly renderings: Renderings;
  /** Supplied for objects that came from outside; enables reconciliation. */
  readonly external?: ExternalIdentity;
  /** Required for local objects; omit for world scope. */
  readonly workstreamId?: string;
  /** Producer-supplied "what's new"; kept only when smaller than the content. */
  readonly delta?: ContentDelta | null;
}

/** An edit names the object; only its content and title can change (§3.8). */
export interface EditObjectInput {
  readonly renderings: Renderings;
  readonly title?: string;
  readonly delta?: ContentDelta | null;
}

export interface WriteResult {
  readonly objectId: string;
  readonly versionId: string;
  readonly ordinal: number;
  /** False when content was unchanged — a re-read that changed nothing. */
  readonly created: boolean;
}

export interface ObjectContent {
  readonly objectId: string;
  readonly versionId: string;
  readonly ordinal: number;
  readonly renderings: Renderings;
  readonly delta: ContentDelta | null;
}

const BLOB_OWNER = "object_version";

/**
 * Objects, their content, and their versions (spec §3.1, §3.2).
 *
 * Content goes through the blob store, so a large document spills to a file
 * and identical content across versions is stored once. Every write is a
 * version; an unchanged re-read makes none.
 */
export class ObjectStore {
  private readonly blobs: BlobStore;

  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {
    this.blobs = new BlobStore(state, now);
  }

  /**
   * Create or reconcile. An object carrying external identity is matched on
   * that identity, so re-reading a ticket updates it rather than duplicating
   * it (§3.1). Content identical to the latest version writes nothing.
   */
  write(input: WriteObjectInput): WriteResult {
    const scope = input.workstreamId ? "local" : "world";
    const existing = input.external
      ? this.findByExternal(input.external)
      : null;
    const contentHash = createHash("sha256")
      .update(input.renderings.agentContent)
      .digest("hex");

    if (existing) return this.appendTo(existing.id, input, contentHash);

    const objectId = newObjectId();

    this.state.db
      .insert(objects)
      .values({
        id: objectId,
        kind: input.kind,
        scope,
        workstreamId: input.workstreamId ?? null,
        externalSystem: input.external?.system ?? null,
        externalId: input.external?.id ?? null,
        title: input.title,
        latestVersionId: null,
        createdAt: this.now(),
      })
      .run();

    const version = this.appendVersion(objectId, input, null);

    this.state.db
      .update(objects)
      .set({ latestVersionId: version.id })
      .where(eq(objects.id, objectId))
      .run();

    return {
      objectId,
      versionId: version.id,
      ordinal: version.ordinal,
      created: true,
    };
  }

  /**
   * Edit content that already exists (§3.8): "a note you cannot edit is not a
   * note", and each edit is a new version, drifting consumers like any other
   * change. Distinct from {@link write}, which reconciles on *external*
   * identity — app-authored content has none, so editing it has to name the
   * object rather than be matched to it.
   */
  edit(objectId: string, input: EditObjectInput): WriteResult {
    const row = this.require(objectId);
    const contentHash = createHash("sha256")
      .update(input.renderings.agentContent)
      .digest("hex");

    return this.appendTo(
      objectId,
      {
        kind: row.kind as ObjectKind,
        title: input.title ?? row.title,
        renderings: input.renderings,
        ...(input.delta !== undefined ? { delta: input.delta } : {}),
      },
      contentHash,
    );
  }

  /**
   * Read content. The last-known content of anything placed is retained, so
   * this still answers after a restart or when the source stopped returning
   * the object (§3.2).
   */
  read(objectId: string, versionId?: string): ObjectContent {
    const row = versionId
      ? this.state.db
          .select()
          .from(objectVersions)
          .where(eq(objectVersions.id, versionId))
          .get()
      : this.latestVersionRow(objectId);

    if (!row) {
      throw new EntityNotFound(
        "object version",
        objectId,
        `no version for object ${objectId}`,
      );
    }

    return {
      objectId: row.objectId,
      versionId: row.id,
      ordinal: row.ordinal,
      renderings: {
        card: JSON.parse(row.cardJson) as Record<string, unknown>,
        summary: row.summary,
        agentContent: this.blobs.text(row.contentBlobId),
      },
      delta:
        row.deltaBlobId && row.deltaSummary
          ? {
              summary: row.deltaSummary,
              body: this.blobs.text(row.deltaBlobId),
            }
          : null,
    };
  }

  get(objectId: string): ObjectRow | undefined {
    return this.state.db
      .select()
      .from(objects)
      .where(eq(objects.id, objectId))
      .get();
  }

  findByExternal(external: ExternalIdentity): ObjectRow | undefined {
    return this.state.db
      .select()
      .from(objects)
      .where(
        and(
          eq(objects.externalSystem, external.system),
          eq(objects.externalId, external.id),
        ),
      )
      .get();
  }

  versions(objectId: string): ObjectVersion[] {
    return this.state.db
      .select()
      .from(objectVersions)
      .where(eq(objectVersions.objectId, objectId))
      .orderBy(objectVersions.ordinal)
      .all()
      .map(toDomainVersion);
  }

  /**
   * Spec §3.2: locality is a default, not a definition. Promote lifts an
   * existing local object to world scope in one gesture — distinct from
   * publish, which marks a placeholder before a run (§3.5).
   */
  promote(objectId: string): void {
    const row = this.get(objectId);
    if (!row) throw new EntityNotFound("object", objectId);
    if (row.scope === "world") return;

    this.state.db
      .update(objects)
      .set({ scope: "world", workstreamId: null, promotedAt: this.now() })
      .where(eq(objects.id, objectId))
      .run();
  }

  /**
   * Delete an object. Soft, because deletion is recoverable for authored
   * state — including when an agent did the deleting (principle 10). The
   * versions stay exactly where they are: a run that consumed this object
   * must remain comparable (§15-1), and an undone deletion that lost the
   * content would not be an undo.
   */
  delete(objectId: string): ObjectRow {
    const row = this.get(objectId);
    if (!row) throw new EntityNotFound("object", objectId);
    if (row.deletedAt !== null) return row;

    this.state.db
      .update(objects)
      .set({ deletedAt: this.now() })
      .where(eq(objects.id, objectId))
      .run();

    return this.require(objectId);
  }

  restore(objectId: string): ObjectRow {
    const row = this.get(objectId);
    if (!row) throw new EntityNotFound("object", objectId);

    this.state.db
      .update(objects)
      .set({ deletedAt: null })
      .where(eq(objects.id, objectId))
      .run();

    return this.require(objectId);
  }

  /** What the undo verb can put back (principle 10). */
  deleted(): ObjectRow[] {
    return this.state.db
      .select()
      .from(objects)
      .where(isNotNull(objects.deletedAt))
      .all();
  }

  /**
   * Every live object (Epic 2.2's snapshot read): the converse of
   * {@link deleted}, and what a client that replayed every `object` event
   * from scratch would end up holding.
   */
  live(): ObjectRow[] {
    return this.state.db
      .select()
      .from(objects)
      .where(isNull(objects.deletedAt))
      .all();
  }

  /**
   * Mark versions consumed by a run. Run-referenced versions are retained so
   * any two runs stay comparable forever (§4.4, §15 invariant 1).
   */
  markRunReferenced(versionIds: readonly string[], pinned = false): void {
    if (versionIds.length === 0) return;

    this.state.db
      .update(objectVersions)
      .set({ runReferenced: true, ...(pinned ? { pinned: true } : {}) })
      .where(inArray(objectVersions.id, [...versionIds]))
      .run();
  }

  /** Pinning is the human's word for "never compact this" (§4.4). */
  setPinned(versionIds: readonly string[], pinned: boolean): void {
    if (versionIds.length === 0) return;

    this.state.db
      .update(objectVersions)
      .set({ pinned })
      .where(inArray(objectVersions.id, [...versionIds]))
      .run();
  }

  /**
   * Spec §3.2 / §15 invariant 3: compact unreferenced intermediate versions
   * after a window. Latest versions, run-referenced versions, and pinned
   * versions are never touched — nothing referenced is ever lost.
   *
   * This removes version rows and their blob references; the bytes go when the
   * blob store next compacts, which is what makes dedup safe.
   */
  compactVersions(policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY): {
    removed: number;
  } {
    const now = this.now();
    const cutoff = now - policy.windowSeconds;

    const candidates = this.state.db
      .select({
        id: objectVersions.id,
        objectId: objectVersions.objectId,
        contentBlobId: objectVersions.contentBlobId,
        deltaBlobId: objectVersions.deltaBlobId,
      })
      .from(objectVersions)
      .innerJoin(objects, eq(objects.id, objectVersions.objectId))
      .where(
        and(
          eq(objectVersions.runReferenced, false),
          eq(objectVersions.pinned, false),
          lt(objectVersions.createdAt, cutoff),
          // Never the latest version of its object.
          sql`${objectVersions.id} IS NOT ${objects.latestVersionId}`,
        ),
      )
      .all();

    for (const candidate of candidates) {
      // Dropping a version's references and dropping the version are one act.
      // Halfway between them there is a version nothing claims the content of —
      // and the blob sweep would then be free to delete bytes a live version
      // still points at, including one somebody pins in the meantime. One
      // transaction per candidate, not one for the sweep: a partial sweep is
      // fine, a partial *candidate* is not.
      this.state.db.transaction(() => {
        this.blobs.dereference(candidate.contentBlobId, {
          ownerKind: BLOB_OWNER,
          ownerId: candidate.id,
        });

        if (candidate.deltaBlobId) {
          this.blobs.dereference(candidate.deltaBlobId, {
            ownerKind: BLOB_OWNER,
            ownerId: candidate.id,
          });
        }

        this.state.db
          .delete(objectVersions)
          .where(eq(objectVersions.id, candidate.id))
          .run();
      });
    }

    return { removed: candidates.length };
  }

  /** Objects whose content is still held despite having no external source. */
  orphanedWorldObjects(): ObjectRow[] {
    return this.state.db
      .select()
      .from(objects)
      .where(and(eq(objects.scope, "world"), isNull(objects.externalSystem)))
      .all();
  }

  /**
   * Append a version to an object that exists. Content identical to the
   * latest version writes no version — a re-read that changed nothing is not
   * a change, and recording it as one would drift every consumer for free.
   */
  private appendTo(
    objectId: string,
    input: WriteObjectInput,
    contentHash: string,
  ): WriteResult {
    const latest = this.latestVersionRow(objectId);

    if (latest && latest.contentHash === contentHash) {
      this.state.db
        .update(objects)
        .set({ title: input.title })
        .where(eq(objects.id, objectId))
        .run();

      return {
        objectId,
        versionId: latest.id,
        ordinal: latest.ordinal,
        created: false,
      };
    }

    const version = this.appendVersion(objectId, input, latest);

    this.state.db
      .update(objects)
      .set({ title: input.title, latestVersionId: version.id })
      .where(eq(objects.id, objectId))
      .run();

    return {
      objectId,
      versionId: version.id,
      ordinal: version.ordinal,
      created: true,
    };
  }

  private require(objectId: string): ObjectRow {
    const row = this.get(objectId);
    if (!row) throw new EntityNotFound("object", objectId);
    return row;
  }

  private latestVersionRow(objectId: string): ObjectVersionRow | undefined {
    return this.state.db
      .select()
      .from(objectVersions)
      .where(eq(objectVersions.objectId, objectId))
      .orderBy(sql`${objectVersions.ordinal} DESC`)
      .limit(1)
      .get();
  }

  private appendVersion(
    objectId: string,
    input: WriteObjectInput,
    previous: ObjectVersionRow | undefined | null,
  ): { id: string; ordinal: number } {
    const id = newVersionId();
    const ordinal = (previous?.ordinal ?? 0) + 1;

    const content = this.blobs.put(input.renderings.agentContent, {
      kind: "object_content",
    });
    this.blobs.reference(content.id, {
      ownerKind: BLOB_OWNER,
      ownerId: id,
    });

    const delta = chooseDelta(
      input.delta ?? null,
      input.renderings.agentContent,
    );
    let deltaBlobId: string | null = null;

    if (delta) {
      const stored = this.blobs.put(delta.body, { kind: "object_delta" });
      this.blobs.reference(stored.id, { ownerKind: BLOB_OWNER, ownerId: id });
      deltaBlobId = stored.id;
    }

    this.state.db
      .insert(objectVersions)
      .values({
        id,
        objectId,
        ordinal,
        contentHash: createHash("sha256")
          .update(input.renderings.agentContent)
          .digest("hex"),
        contentBlobId: content.id,
        cardJson: JSON.stringify(input.renderings.card),
        summary: input.renderings.summary,
        deltaSummary: delta?.summary ?? null,
        deltaBlobId,
        createdAt: this.now(),
      })
      .run();

    return { id, ordinal };
  }
}

function toDomainVersion(row: ObjectVersionRow): ObjectVersion {
  return {
    id: row.id as ObjectVersion["id"],
    objectId: row.objectId as ObjectVersion["objectId"],
    ordinal: row.ordinal,
    contentHash: row.contentHash,
    summary: row.summary,
    runReferenced: row.runReferenced,
    pinned: row.pinned,
    createdAt: row.createdAt,
  };
}

export { isCompactable };
