import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addonFilesIn,
  nativeAddonPackage,
  SessionHostCompileError,
} from "./compile.js";

describe("nativeAddonPackage", () => {
  it("names the platform package the addon is copied from", () => {
    expect(nativeAddonPackage("linux", "x64")).toBe(
      "@oh-my-pi/pi-natives-linux-x64",
    );
    expect(nativeAddonPackage("win32", "x64")).toBe(
      "@oh-my-pi/pi-natives-win32-x64",
    );
  });

  it("refuses a platform with no published addon", () => {
    // A compiled binary loads its addon from beside itself, so a host with none
    // to copy cannot produce a working artifact. Refusing here is the difference
    // between a named failure and a binary that dies on first launch.
    expect(() => nativeAddonPackage("linux", "arm")).toThrow(
      SessionHostCompileError,
    );
    expect(() => nativeAddonPackage("freebsd", "x64")).toThrow(
      /publishes no native addon for freebsd-x64/,
    );
  });
});

describe("addonFilesIn", () => {
  it("takes every addon variant, because the running CPU picks one", () => {
    const directory = mkdtempSync(join(tmpdir(), "plotroom-addon-"));
    writeFileSync(join(directory, "pi_natives.linux-x64-modern.node"), "");
    writeFileSync(join(directory, "pi_natives.linux-x64-baseline.node"), "");
    writeFileSync(join(directory, "package.json"), "{}");

    expect(addonFilesIn(directory)).toEqual([
      "pi_natives.linux-x64-baseline.node",
      "pi_natives.linux-x64-modern.node",
    ]);
  });

  it("refuses a directory holding no addon at all", () => {
    const directory = mkdtempSync(join(tmpdir(), "plotroom-addon-"));
    writeFileSync(join(directory, "package.json"), "{}");

    expect(() => addonFilesIn(directory)).toThrow(SessionHostCompileError);
  });
});
