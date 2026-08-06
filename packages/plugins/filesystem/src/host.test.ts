/**
 * The plugin loaded in the **real** worker_threads host (§10.2), not just
 * unit-tested against its handlers directly (`producer.test.ts`) — proving
 * the manifest actually crosses the worker boundary, is read into a
 * descriptor, passes conformance, and answers `concept.read` /
 * `card.render` / `content.render` invocations gated by the host's own
 * permission and redaction machinery.
 *
 * Loads `src/index.ts` directly (#315: no build, raw-TS `exports`) — the
 * same module the product loads in the box. This plugin is organized
 * across several files with runtime `./foo.js` specifiers resolving to
 * sibling `.ts` files, which Bun's module resolution (both running this
 * suite and inside the `worker_threads` host it spawns) handles natively;
 * that is why this file runs under `bun test`, not vitest — a vitest
 * worker pool does not inherit Bun's loader, so it cannot resolve those
 * specifiers (see the git/github/jira plugins' own
 * `host.integration.test.ts` for the same fix).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import type { PermissionGrant } from "@plotroom/plugin-sdk";
import { PluginCallRefusedError, PluginHost } from "@plotroom/plugin-sdk";

const hosts: PluginHost[] = [];
const dirs: string[] = [];

const moduleUrl = (): URL => new URL("../src/index.ts", import.meta.url);

const load = async (
  grants: readonly PermissionGrant[] = [],
): Promise<PluginHost> => {
  const host = await PluginHost.load(moduleUrl(), { grants });
  hosts.push(host);
  return host;
};

const granted = (permissionId: string): PermissionGrant => ({
  pluginId: "filesystem",
  permissionId,
  state: "granted",
  answeredAt: 1,
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "plotroom-fs-plugin-host-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("the filesystem plugin, loaded in a real worker", () => {
  it("loads ready, reporting its contributions", async () => {
    const host = await load();
    expect(host.health.status).toBe("ready");
    const points = new Set(host.descriptor?.contributions.map((c) => c.point));
    expect(points).toEqual(
      new Set([
        "concept-producer",
        "content-renderer",
        "card-renderer",
        "palette-entry",
      ]),
    );
  });

  it("refuses concept.read before fs-read is granted, raising the permission", async () => {
    const host = await load([]);
    await expect(
      host.invoke({
        kind: "concept.read",
        contributionId: "fs-documents",
        request: { scope: null, externalId: "/tmp" },
      }),
    ).rejects.toThrow(PluginCallRefusedError);
  });

  it("reads a real file end to end once fs-read is granted", async () => {
    const dir = await tempDir();
    const path = join(dir, "hello.txt");
    await writeFile(path, "hello from the real worker host");

    const host = await load([granted("fs-read")]);
    const result = await host.invoke({
      kind: "concept.read",
      contributionId: "fs-documents",
      request: { scope: null, externalId: path },
    });

    expect(result.unavailable).toEqual([]);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]!.renderings.agentContent).toContain(
      "hello from the real worker host",
    );
  });

  it("browses a directory end to end, returning the root and its children", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.txt"), "a");
    await mkdir(join(dir, "sub"));

    const host = await load([granted("fs-read")]);
    const result = await host.invoke({
      kind: "concept.read",
      contributionId: "fs-documents",
      request: { scope: dir, externalId: null },
    });

    const ids = result.objects.map((o) => o.externalId).sort();
    expect(ids).toEqual([dir, join(dir, "a.txt"), join(dir, "sub")].sort());
  });

  it("renders a card for a produced object (mechanics only, no permission needed)", async () => {
    const dir = await tempDir();
    const path = join(dir, "hello.txt");
    await writeFile(path, "hi");

    const host = await load([granted("fs-read")]);
    const read = await host.invoke({
      kind: "concept.read",
      contributionId: "fs-documents",
      request: { scope: null, externalId: path },
    });
    const object = read.objects[0]!;

    const card = await host.invoke({
      kind: "card.render",
      contributionId: "fs-card",
      object,
      detail: "expanded",
    });

    expect(card.title).toContain("file");
    expect(card.lines).toContain(path);
    expect(card.actions).toEqual([]);
  });

  it("renders agent content with the truncated field set for an oversized file", async () => {
    const dir = await tempDir();
    const path = join(dir, "big.txt");
    await writeFile(path, "x".repeat(70_000));

    const host = await load([granted("fs-read")]);
    const read = await host.invoke({
      kind: "concept.read",
      contributionId: "fs-documents",
      request: { scope: null, externalId: path },
    });
    const object = read.objects[0]!;

    const rendered = await host.invoke({
      kind: "content.render",
      contributionId: "fs-content",
      object,
    });

    expect(rendered.truncated).not.toBeNull();
    expect(rendered.truncated?.omittedBytes).toBeGreaterThan(0);
  });
});
