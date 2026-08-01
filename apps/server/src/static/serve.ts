import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

/**
 * Single-origin serving (Epic 3.0, spec §12): the browser talks to exactly
 * one origin. This middleware serves the built renderer (`apps/web`'s dist,
 * built by Track B) as static files on the same port as `/api` and `/ws` —
 * whatever that build produces; this module never shapes or modifies it.
 *
 * SPA fallback: an unmatched GET that isn't under `/api` or `/ws` resolves to
 * `index.html`, because "selection as route" (spec §5) is client-side
 * routing — the server does not know its paths.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeFor(path: string): string {
  return (
    CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

/** Resolves a request path under `root`, refusing to escape it (`..`). */
function resolveWithinRoot(root: string, requestPath: string): string | null {
  const cleaned = normalize(requestPath).replace(/^([.][.][/\\])+/, "");
  const candidate = resolve(join(root, cleaned));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

function fileIfExists(path: string): string | null {
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

export interface ServeRendererOptions {
  readonly rootDir: string;
}

/**
 * Builds the static-serving middleware, or `null` if the renderer hasn't
 * been built yet (Epic 3.0 lands separately) — the caller decides what a
 * missing renderer means for the response instead of this module guessing.
 */
export function serveRenderer(
  options: ServeRendererOptions,
): MiddlewareHandler | null {
  const root = resolve(options.rootDir);
  if (!existsSync(root)) return null;

  const indexHtml = fileIfExists(join(root, "index.html"));

  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await next();
      return;
    }

    const url = new URL(c.req.url);
    const resolved = resolveWithinRoot(root, decodeURIComponent(url.pathname));
    const filePath = resolved ? fileIfExists(resolved) : null;
    const servePath = filePath ?? indexHtml;

    if (servePath === null) {
      await next();
      return;
    }

    c.header("content-type", contentTypeFor(servePath));
    if (c.req.method === "HEAD") {
      c.status(200);
      return c.body(null);
    }
    return c.body(readFileSync(servePath));
  };
}
