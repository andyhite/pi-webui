/**
 * The real filesystem adapter for `ConfigIo` (`desktop-config.ts`) — the
 * only file that touches `node:fs` for desktop config, so every other
 * module stays testable against an in-memory fake.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ConfigIo } from "./desktop-config.js";

export const nodeConfigIo: ConfigIo = {
  readFile(path) {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  },
  writeFile(path, contents) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  },
};
