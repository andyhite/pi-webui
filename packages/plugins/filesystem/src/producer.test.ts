/**
 * Producer round trips (§9.4, §3.1/§3.2, principle 12), against real temp
 * dirs — hermetic, no reads outside what each test creates and removes.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { decodeCardMeta } from "./card-meta.js";
import {
  DIRECTORY_MAX_ENTRIES,
  FILE_INLINE_MAX_BYTES,
  filesystemConceptProducer,
} from "./producer.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "plotroom-fs-plugin-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const context = {
  invocationId: "test",
  actor: null,
  credentials: {},
  grants: [],
  log: () => undefined,
};

const read = (request: { scope?: string | null; externalId?: string | null }) =>
  filesystemConceptProducer.read(
    { scope: request.scope ?? null, externalId: request.externalId ?? null },
    context,
  );

describe("declared shape", () => {
  it("is on-demand refresh, deferred from observed (§10.1's RefreshMode)", () => {
    expect(filesystemConceptProducer.refresh).toEqual({ kind: "on-demand" });
  });

  it("claims only the document concept kind", () => {
    expect(filesystemConceptProducer.kinds).toEqual(["document"]);
  });

  it("declares the fs-read permission it needs", () => {
    expect(filesystemConceptProducer.permissions).toEqual(["fs-read"]);
  });
});

describe("a file, read by external id (per-object refresh)", () => {
  it("round-trips content and identity", async () => {
    const dir = await tempDir();
    const path = join(dir, "note.txt");
    await writeFile(path, "hello filesystem plugin");

    const result = await read({ externalId: path });

    expect(result.unavailable).toEqual([]);
    expect(result.objects).toHaveLength(1);
    const object = result.objects[0]!;
    expect(object.kind).toBe("document");
    expect(object.externalId).toBe(path);
    expect(object.title).toBe("note.txt");
    expect(object.renderings.agentContent).toContain("hello filesystem plugin");
    const meta = decodeCardMeta(object.renderings.card);
    expect(meta).toEqual({
      fsKind: "file",
      sizeBytes: "hello filesystem plugin".length,
      truncated: null,
    });
  });

  it("reconciles a re-read onto the same external id after the content changes", async () => {
    const dir = await tempDir();
    const path = join(dir, "note.txt");
    await writeFile(path, "v1");
    const first = await read({ externalId: path });
    await writeFile(path, "v2, longer");
    const second = await read({ externalId: path });

    expect(first.objects[0]!.externalId).toBe(second.objects[0]!.externalId);
    expect(second.objects[0]!.renderings.agentContent).toContain("v2, longer");
  });

  it("truncates a file larger than the inline bound, reporting it via the card-meta channel and in-band", async () => {
    const dir = await tempDir();
    const path = join(dir, "big.txt");
    const oversized = "a".repeat(FILE_INLINE_MAX_BYTES + 100);
    await writeFile(path, oversized);

    const result = await read({ externalId: path });
    const object = result.objects[0]!;
    const meta = decodeCardMeta(object.renderings.card);

    expect(meta?.truncated).toEqual({
      omittedBytes: 100,
      why: `file is ${FILE_INLINE_MAX_BYTES + 100} bytes; only the first ${FILE_INLINE_MAX_BYTES} bytes are inlined`,
    });
    expect(object.renderings.agentContent).toContain("[truncated:");
    expect(object.renderings.summary).toContain("truncated");
    // Never silently cut short of the stated bound.
    expect(object.renderings.agentContent.length).toBeLessThan(
      oversized.length + 200,
    );
  });

  it("reports a binary file's size without inlining garbled bytes", async () => {
    const dir = await tempDir();
    const path = join(dir, "bin.dat");
    await writeFile(path, Buffer.from([0, 1, 2, 3, 0, 255]));

    const result = await read({ externalId: path });
    const object = result.objects[0]!;
    expect(object.renderings.agentContent).toContain("binary file");
    expect(object.renderings.agentContent).not.toContain("\u0000");
  });

  it("refuses a relative path rather than guessing a root", async () => {
    const result = await read({ externalId: "relative/path.txt" });
    expect(result.objects).toEqual([]);
    expect(result.unavailable).toEqual([
      {
        externalId: "relative/path.txt",
        why: "filesystem identity must be an absolute path",
      },
    ]);
  });

  it("reports a missing path as unavailable, never as an empty document", async () => {
    const dir = await tempDir();
    const missing = join(dir, "nope.txt");
    const result = await read({ externalId: missing });
    expect(result.objects).toEqual([]);
    expect(result.unavailable).toHaveLength(1);
    expect(result.unavailable[0]!.externalId).toBe(missing);
  });
});

describe("a directory, read by external id", () => {
  it("lists its immediate children as browsable structure, not file content", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.txt"), "a");
    await mkdir(join(dir, "sub"));

    const result = await read({ externalId: dir });
    const object = result.objects[0]!;
    const meta = decodeCardMeta(object.renderings.card);

    expect(meta?.fsKind).toBe("directory");
    expect(meta?.sizeBytes).toBe(2);
    expect(object.renderings.agentContent).toContain("file  a.txt");
    expect(object.renderings.agentContent).toContain("dir   sub");
  });

  it("truncates a directory with more entries than the bound, stating the count", async () => {
    const dir = await tempDir();
    const total = DIRECTORY_MAX_ENTRIES + 5;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        writeFile(join(dir, `f${String(i).padStart(4, "0")}.txt`), ""),
      ),
    );

    const result = await read({ externalId: dir });
    const object = result.objects[0]!;
    const meta = decodeCardMeta(object.renderings.card);

    expect(meta?.sizeBytes).toBe(total);
    expect(meta?.truncated).toEqual({
      omittedBytes: 5,
      why: `directory has ${total} entries; only the first ${DIRECTORY_MAX_ENTRIES} are listed`,
    });
    expect(object.renderings.agentContent).toContain("[truncated:");
  });
});

describe("whole-integration read (browse): scope names a root, externalId is null", () => {
  it("returns the root plus each immediate child as its own document", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.txt"), "A");
    await writeFile(join(dir, "b.txt"), "B");
    await mkdir(join(dir, "sub"));

    const result = await read({ scope: dir });

    expect(result.unavailable).toEqual([]);
    const ids = result.objects.map((o) => o.externalId).sort();
    expect(ids).toEqual(
      [dir, join(dir, "a.txt"), join(dir, "b.txt"), join(dir, "sub")].sort(),
    );
    const a = result.objects.find((o) => o.externalId === join(dir, "a.txt"));
    expect(a?.renderings.agentContent).toContain("A");
  });

  it("is an honest empty when nothing is configured (never a guessed default root)", async () => {
    const result = await read({ scope: null });
    expect(result).toEqual({ objects: [], unavailable: [] });
  });

  it("refuses a relative scope rather than resolving it against something implicit", async () => {
    const result = await read({ scope: "relative/dir" });
    expect(result.objects).toEqual([]);
    expect(result.unavailable[0]!.why).toMatch(/absolute path/);
  });
});
