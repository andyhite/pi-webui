/**
 * The real filesystem adapter for `ConfigIo` (`desktop-config.ts`) — the
 * only file that touches `node:fs` for desktop config, so every other
 * module stays testable against an in-memory fake.
 *
 * `writeFile` writes to a temp file beside the target and renames it into
 * place (principle 11): a bare `writeFileSync` truncates the destination
 * before writing its new content, so a kill mid-write leaves a corrupt or
 * empty `desktop-config.json` — read back by `parseDesktopConfig` as the
 * empty config, which silently reverts to local spawn-or-attach with every
 * remembered backend gone. `renameSync` on the same filesystem (guaranteed
 * here: the temp file is a sibling of the target) is atomic, so a reader
 * only ever sees the old complete file or the new complete file, never a
 * partial one.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { ConfigIo } from "./desktop-config.js";

export const nodeConfigIo: ConfigIo = {
  readFile(path) {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  },
  writeFile(path, contents) {
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
    writeFileSync(tempPath, contents, "utf8");
    renameSync(tempPath, path);
  },
};
