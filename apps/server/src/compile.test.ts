import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  BINARY_NAME,
  OUT_DIR,
  ServerCompileError,
  smokeTest,
} from "./compile.js";

/** `true(1)` is a POSIX standard, but not at one standard path — `/bin/true`
 * on Linux, `/usr/bin/true` on macOS — so it is resolved off `PATH` rather
 * than hardcoded. */
const NEVER_LISTENS = Bun.which("true");

describe("BINARY_NAME", () => {
  it("names a per-platform artifact, .exe only on Windows", () => {
    expect(BINARY_NAME).toBe(
      process.platform === "win32" ? "plotroom-server.exe" : "plotroom-server",
    );
  });
});

describe("smokeTest", () => {
  // Guarded: this exercises the real compiled artifact (`bun run compile`),
  // which this suite does not build for itself — a multi-minute `bun build
  // --compile` on every `bun test` run would be the exact "whole suite pays
  // for one path" cost the rest of this package's tests avoid. Run
  // `bun run compile` first, then `bun test src/compile.test.ts`, to prove
  // this against a real binary; skipped rather than faked when none exists.
  const binary = join(import.meta.dir, "..", OUT_DIR, BINARY_NAME);

  it.skipIf(!existsSync(binary))(
    "answers its own /api/health once spawned, against a real compiled binary",
    async () => {
      await smokeTest(binary);
    },
    30_000,
  );

  it.skipIf(NEVER_LISTENS === null)(
    "refuses a binary that never answers health, rather than hanging forever",
    async () => {
      // `true`-shaped: a program that exists, runs, and never listens on
      // anything — the exact shape `smokeTest`'s bounded poll exists to
      // catch rather than hang on (the same class of bug named on #261,
      // applied to this compile-time check instead of the desktop shell's
      // spawn path).
      await expect(smokeTest(NEVER_LISTENS as string)).rejects.toThrow(
        ServerCompileError,
      );
    },
    25_000,
  );
});
