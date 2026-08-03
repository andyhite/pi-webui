/**
 * The Filesystem plugin's concept producer (§9.4, §10.1, §3.1/§3.2).
 *
 * Files and directories both become `document` concepts — the task this
 * plugin was built against says so explicitly, and it sidesteps the open
 * "collection membership model" question (AGENTS.md) entirely: a directory
 * is "browsable structure" rendered as one document's content, never a
 * `collection` whose membership schema doesn't exist yet.
 *
 * **External identity is the absolute path** (§3.1): re-reading the same
 * path reconciles onto the same object rather than duplicating, exactly like
 * a re-synced ticket. A relative path or one that fails to resolve is refused
 * as `unavailable` rather than silently guessed at.
 *
 * **Refresh is `on-demand`.** A filesystem watcher would be `observed`
 * (§10.1's `RefreshMode`), and the contract can express it — but Track A's
 * integration substrate (`apps/server/src/integrations/`) has no push seam
 * today (refresh is host-scheduled reads only: on-demand or interval). Wiring
 * a real watcher is deferred until that seam exists; recorded here rather
 * than silently doing interval-polling instead, which would be a different,
 * unrequested behavior.
 *
 * **No silent truncation (principle 12).** A file larger than
 * {@link FILE_INLINE_MAX_BYTES} or a directory with more than
 * {@link DIRECTORY_MAX_ENTRIES} immediate entries is still returned — never
 * refused for being large — but every produced object says so in-band (its
 * `agentContent` ends with a stated omission) *and* out-of-band, through
 * `card-meta.ts`'s `truncated` field, which `content-renderer.ts` surfaces as
 * the contract's own `RenderedContent.truncated`. Two channels because
 * `Renderings` (the producer's shape) has no truncation field of its own —
 * only `RenderedContent` (the content renderer's shape) does; see that
 * file's doc comment for why the content renderer cannot simply re-open the
 * file to compute it independently.
 */
import { open, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type {
  ConceptProducer,
  ProducedObject,
  ReadRequest,
  ReadResult,
} from "@plotroom/plugin-sdk";

import { encodeCardMeta, type Truncation } from "./card-meta.js";
import { FS_READ_PERMISSION_ID } from "./permissions.js";

/** Matches AGENTS.md's `INLINE_MAX_BYTES` convention for blobs (64KB) — the
 * same "small enough to inline, otherwise it spills" bound this product
 * already uses elsewhere, reused rather than inventing a second number. */
export const FILE_INLINE_MAX_BYTES = 64 * 1024;

/** Bounded so a directory with a million entries cannot make one read
 * unbounded work; the count is stated whether or not it was hit. */
export const DIRECTORY_MAX_ENTRIES = 500;

interface FileRead {
  readonly text: string;
  readonly sizeBytes: number;
  readonly truncated: Truncation | null;
  readonly binary: boolean;
}

async function readFileBounded(path: string): Promise<FileRead> {
  const info = await stat(path);
  const handle = await open(path, "r");
  try {
    const toRead = Math.min(info.size, FILE_INLINE_MAX_BYTES);
    const buffer = Buffer.alloc(toRead);
    await handle.read(buffer, 0, toRead, 0);
    // A NUL byte in the first slice is the same "probably binary" heuristic
    // most tools use; a full content-type sniff is out of scope for v1 —
    // reported here rather than silently emitting garbled bytes as text.
    const binary = buffer
      .subarray(0, Math.min(buffer.length, 8000))
      .includes(0);
    const omittedBytes = info.size - toRead;
    return {
      text: binary ? "" : buffer.toString("utf8"),
      sizeBytes: info.size,
      truncated:
        omittedBytes > 0
          ? {
              omittedBytes,
              why: `file is ${info.size} bytes; only the first ${FILE_INLINE_MAX_BYTES} bytes are inlined`,
            }
          : null,
      binary,
    };
  } finally {
    await handle.close();
  }
}

interface DirectoryRead {
  readonly lines: readonly string[];
  readonly totalEntries: number;
  readonly truncated: Truncation | null;
}

async function readDirectoryBounded(path: string): Promise<DirectoryRead> {
  const entries = await readdir(path, { withFileTypes: true });
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.slice(0, DIRECTORY_MAX_ENTRIES);
  const lines = shown.map(
    (entry) => `${entry.isDirectory() ? "dir " : "file"}  ${entry.name}`,
  );
  const omitted = sorted.length - shown.length;
  return {
    lines,
    totalEntries: sorted.length,
    truncated:
      omitted > 0
        ? {
            omittedBytes: omitted,
            why: `directory has ${sorted.length} entries; only the first ${DIRECTORY_MAX_ENTRIES} are listed`,
          }
        : null,
  };
}

/** One path, resolved into exactly one `document` (§3.1's per-path identity). */
async function readPathAsDocument(
  absolutePath: string,
): Promise<
  | { readonly ok: true; readonly object: ProducedObject }
  | { readonly ok: false; readonly why: string }
> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    return { ok: false, why: describeError(error) };
  }

  const title = basename(absolutePath) || absolutePath;

  if (info.isDirectory()) {
    let listing: DirectoryRead;
    try {
      listing = await readDirectoryBounded(absolutePath);
    } catch (error) {
      return { ok: false, why: describeError(error) };
    }
    const agentContent = [
      `directory: ${absolutePath}`,
      `${listing.totalEntries} entr${listing.totalEntries === 1 ? "y" : "ies"}`,
      ...listing.lines,
      ...(listing.truncated ? [`[truncated: ${listing.truncated.why}]`] : []),
    ].join("\n");
    return {
      ok: true,
      object: {
        kind: "document",
        externalId: absolutePath,
        title,
        renderings: {
          card: encodeCardMeta({
            fsKind: "directory",
            sizeBytes: listing.totalEntries,
            truncated: listing.truncated,
          }),
          summary: listing.truncated
            ? `directory · ${listing.totalEntries} entries (truncated)`
            : `directory · ${listing.totalEntries} entries`,
          agentContent,
        },
      },
    };
  }

  if (info.isFile()) {
    let file: FileRead;
    try {
      file = await readFileBounded(absolutePath);
    } catch (error) {
      return { ok: false, why: describeError(error) };
    }
    const body = file.binary
      ? `[binary file, ${file.sizeBytes} bytes; content not inlined]`
      : file.text;
    const agentContent = file.truncated
      ? `${body}\n\n[truncated: ${file.truncated.why}]`
      : body;
    return {
      ok: true,
      object: {
        kind: "document",
        externalId: absolutePath,
        title,
        renderings: {
          card: encodeCardMeta({
            fsKind: "file",
            sizeBytes: file.sizeBytes,
            truncated: file.truncated,
          }),
          summary: file.truncated
            ? `file · ${file.sizeBytes} bytes (truncated)`
            : `file · ${file.sizeBytes} bytes`,
          agentContent,
        },
      },
    };
  }

  return {
    ok: false,
    why: "neither a file nor a directory (a symlink, device, or socket) — not producible as a document",
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read either one path (a per-object refresh) or a directory's immediate
 * children (a whole-integration "browse"): §9.1's `ReadRequest.externalId`
 * is "present for a per-object refresh; absent for a whole-integration one",
 * and that is exactly the browse/refresh split this producer implements.
 */
async function read(request: ReadRequest): Promise<ReadResult> {
  if (request.externalId !== null) {
    if (!isAbsolute(request.externalId)) {
      return {
        objects: [],
        unavailable: [
          {
            externalId: request.externalId,
            why: "filesystem identity must be an absolute path",
          },
        ],
      };
    }
    const result = await readPathAsDocument(request.externalId);
    return result.ok
      ? { objects: [result.object], unavailable: [] }
      : {
          objects: [],
          unavailable: [{ externalId: request.externalId, why: result.why }],
        };
  }

  // Whole-integration read: `scope` names the configured browse root, in this
  // producer's own "query language" (`ScopingDeclaration.language: "path"`).
  const root = request.scope;
  if (root === null) {
    // Honest absence (§3.1): nothing configured, so nothing is produced —
    // never a guessed-at default root.
    return { objects: [], unavailable: [] };
  }
  if (!isAbsolute(root)) {
    return {
      objects: [],
      unavailable: [
        { externalId: root, why: "the browse root must be an absolute path" },
      ],
    };
  }

  const objects: ProducedObject[] = [];
  const unavailable: { externalId: string; why: string }[] = [];

  const rootResult = await readPathAsDocument(root);
  if (rootResult.ok) {
    objects.push(rootResult.object);
  } else {
    unavailable.push({ externalId: root, why: rootResult.why });
    return { objects, unavailable };
  }

  let children: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    children = entries
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, DIRECTORY_MAX_ENTRIES);
  } catch {
    // The root itself was readable (we just produced it above); its listing
    // failing here is unusual (e.g. a race) but not fatal to the browse.
    children = [];
  }

  for (const name of children) {
    const childPath = root.endsWith("/") ? `${root}${name}` : `${root}/${name}`;
    const childResult = await readPathAsDocument(childPath);
    if (childResult.ok) {
      objects.push(childResult.object);
    } else {
      unavailable.push({ externalId: childPath, why: childResult.why });
    }
  }

  return { objects, unavailable };
}

export const filesystemConceptProducer: ConceptProducer = {
  id: "fs-documents",
  kinds: ["document"],
  refresh: { kind: "on-demand" },
  scoping: {
    language: "path",
    example: "/home/you/project",
  },
  permissions: [FS_READ_PERMISSION_ID],
  read,
};
