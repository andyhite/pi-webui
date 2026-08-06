import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, afterEach, beforeEach, describe, it } from "bun:test";
import { serveRenderer } from "./serve.js";

describe("serveRenderer (Epic 3.0 single-origin serving)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plotroom-static-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<html>root</html>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the renderer has not been built", () => {
    expect(serveRenderer({ rootDir: join(dir, "does-not-exist") })).toBeNull();
  });

  it("serves a matching file with its content type", async () => {
    const app = new Hono();
    app.use("*", serveRenderer({ rootDir: dir })!);

    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toBe("console.log(1)");
  });

  it("falls back to index.html for an unmatched path (SPA routing)", async () => {
    const app = new Hono();
    app.use("*", serveRenderer({ rootDir: dir })!);

    const res = await app.request("/workstreams/abc123");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>root</html>");
  });

  it("refuses to serve outside the root via path traversal", async () => {
    const app = new Hono();
    app.use("*", serveRenderer({ rootDir: dir })!);

    // Falls back to index.html rather than escaping the root or 404ing raw.
    const res = await app.request("/../../etc/passwd");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>root</html>");
  });
});
