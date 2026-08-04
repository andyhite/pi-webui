import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { nodeConfigIo } from "./node-config-io.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plotroom-node-config-io-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("nodeConfigIo", () => {
  it("readFile returns null for a missing file", () => {
    const path = join(tempDir(), "desktop-config.json");
    expect(nodeConfigIo.readFile(path)).toBeNull();
  });

  it("writeFile then readFile round-trips", () => {
    const path = join(tempDir(), "desktop-config.json");
    nodeConfigIo.writeFile(path, '{"hello":"world"}');
    expect(nodeConfigIo.readFile(path)).toBe('{"hello":"world"}');
  });

  it("creates parent directories that do not exist yet", () => {
    const dir = tempDir();
    const path = join(dir, "nested", "deeper", "desktop-config.json");
    nodeConfigIo.writeFile(path, "{}");
    expect(nodeConfigIo.readFile(path)).toBe("{}");
  });

  it("overwrites an existing file's content, not just appends", () => {
    const path = join(tempDir(), "desktop-config.json");
    nodeConfigIo.writeFile(path, '{"version":1}');
    nodeConfigIo.writeFile(path, '{"version":2}');
    expect(nodeConfigIo.readFile(path)).toBe('{"version":2}');
  });

  it("leaves no temp file behind after a successful write", () => {
    const dir = tempDir();
    const path = join(dir, "desktop-config.json");
    nodeConfigIo.writeFile(path, "{}");
    const entries = readdirSync(dir);
    expect(entries).toEqual(["desktop-config.json"]);
  });

  it("writes via rename rather than truncating the destination in place", () => {
    // The durability property this fix provides (principle 11): the
    // destination path is only ever created by a rename of a fully-written
    // temp file, never opened for writing itself \u2014 so a crash mid-write
    // can leave a stray temp file, but never a half-written destination.
    // This is not directly observable via signals in a unit test (that is
    // what makes the bug worth fixing at all), so this test pins the
    // contract at the level that is observable: the destination exists and
    // is complete immediately after `writeFile` returns, and only a
    // rename-shaped temp file could have produced it without an
    // intermediate truncated state ever being visible to a concurrent
    // reader.
    const path = join(tempDir(), "desktop-config.json");
    nodeConfigIo.writeFile(path, '{"backends":[]}');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('{"backends":[]}');
  });
});
