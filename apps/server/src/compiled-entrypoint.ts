/**
 * `compile.ts`'s `Bun.build({ compile: { ... } })` entrypoint — not
 * `index.ts` (its normal module of exports, which also runs its own
 * bootstrap directly when `import.meta.main`, for `bun --watch src/index.ts`
 * and the e2e harnesses' spawned `SERVER_ENTRY`).
 *
 * `import.meta.main` is unconditionally `false` inside a `bun build
 * --compile` executable — a confirmed Bun limitation (oven-sh/bun#6009),
 * reproduced here on a Windows compiled binary specifically: the guarded
 * bootstrap in `index.ts` silently never ran, so the packaged server exited
 * immediately with nothing bound and nothing logged (`Session host binary
 * (windows-latest)`, #316). This file needs no such guard at all: it is
 * never imported by anything (only ever named as `Bun.build`'s
 * `entrypoints`), so calling `bootServer()` unconditionally is exactly
 * correct — the same fix Bun's own issue tracker recommends for exactly
 * this shape (a library-and-CLI module in one file).
 */
import { bootServer } from "./index.js";

bootServer();
