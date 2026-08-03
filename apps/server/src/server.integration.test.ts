import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanAuthor } from "@plotroom/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { loadServerConfig, type ServerConfig } from "./config.js";
import { startServer } from "./index.js";
import { ephemeralPort } from "./testing/harness.js";

/**
 * Ports the OS assigned, reserved up front.
 *
 * `boot()` here is synchronous and called from fifteen places, so the bind probe runs
 * once in a `beforeAll` and hands out what it found: a static band collides with a
 * leaked server or another suite, and the failure is not always a clean EADDRINUSE —
 * it can be requests landing on the other server, surfacing far away as something
 * else. Pre-reserving keeps the call sites synchronous without keeping the guess.
 */
const reserved: number[] = [];

beforeAll(async () => {
  for (let index = 0; index < 24; index += 1) {
    reserved.push(await ephemeralPort());
  }
});

function nextPort(): number {
  const port = reserved.shift();
  if (port === undefined) {
    throw new Error(
      "the reserved port pool is empty; raise the count in this file's beforeAll",
    );
  }
  return port;
}

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const stateDir = mkdtempSync(join(tmpdir(), "plotroom-server-test-"));
  return loadServerConfig(
    {},
    {
      host: "127.0.0.1",
      port: nextPort(),
      stateDir,
      credential: null,
      allowNonLoopbackBind: false,
      trustedOrigins: [],
      staticDir: join(tmpdir(), "plotroom-no-such-renderer-dir"),
      logLevel: "error",
      // No plugin workers: these suites assert nothing about plugins, and a
      // worker per in-box plugin per boot is time nothing here spends usefully.
      pluginsInBox: [],
      ...overrides,
    },
  );
}

type Handle = ReturnType<typeof startServer>;
const handles: Handle[] = [];

function boot(overrides: Partial<ServerConfig> = {}): {
  handle: Handle;
  config: ServerConfig;
} {
  const config = testConfig(overrides);
  const handle = startServer(config);
  handles.push(handle);
  return { handle, config };
}

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop()!;
    const stateDir = handle.db.layout.dir;
    await handle.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

const loopbackOrigin = (port: number) => `http://localhost:${port}`;

describe("server integration (Epic 2.1)", () => {
  it("answers /api/health from a loopback origin", async () => {
    const { config } = boot();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
      headers: { origin: loopbackOrigin(config.port) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("refuses a non-loopback, non-allow-listed origin with the consistent error shape", async () => {
    const { config } = boot();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "forbidden",
        message: expect.stringContaining("origin not trusted"),
      },
    });
  });

  it("requires the operator credential once one is configured", async () => {
    const { config } = boot({ credential: "s3cret" });
    const noAuth = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
      headers: { origin: loopbackOrigin(config.port) },
    });
    expect(noAuth.status).toBe(401);

    const withAuth = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
      headers: {
        origin: loopbackOrigin(config.port),
        authorization: "Bearer s3cret",
      },
    });
    expect(withAuth.status).toBe(200);
  });

  it("404s an unknown route with the consistent error shape", async () => {
    const { config } = boot();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/nope`, {
      headers: { origin: loopbackOrigin(config.port) },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });

  it("reports 503 with a clear message when the renderer has not been built", async () => {
    const { config } = boot();
    const res = await fetch(`http://127.0.0.1:${config.port}/`, {
      headers: { origin: loopbackOrigin(config.port) },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("renderer_not_built");
  });

  it("adjusts the log level at runtime via PATCH /api/log-level, validated", async () => {
    const { handle, config } = boot();

    const bad = await fetch(`http://127.0.0.1:${config.port}/api/log-level`, {
      method: "PATCH",
      headers: {
        origin: loopbackOrigin(config.port),
        "content-type": "application/json",
      },
      body: JSON.stringify({ level: "not-a-level" }),
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe("bad_request");

    expect(handle.logger.level).toBe("error");
    const ok = await fetch(`http://127.0.0.1:${config.port}/api/log-level`, {
      method: "PATCH",
      headers: {
        origin: loopbackOrigin(config.port),
        "content-type": "application/json",
      },
      body: JSON.stringify({ level: "debug" }),
    });
    expect(ok.status).toBe(200);
    expect(handle.logger.level).toBe("debug");
  });

  it("keeps the log level the operator's own (§8)", async () => {
    const { handle, config } = boot();

    // Both verbs are declared `humanOnly`, and the actor is what enforces that.
    // What a session would do with it is the point: turning the log down is how you
    // make your own behaviour harder to see.
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", JSON.stringify({ level: "debug" })],
    ] as const) {
      const refused = await fetch(
        `http://127.0.0.1:${config.port}/api/log-level`,
        {
          method,
          headers: {
            origin: loopbackOrigin(config.port),
            "content-type": "application/json",
            "x-plotroom-actor": "session:sess_curious",
          },
          ...(body === undefined ? {} : { body }),
        },
      );
      expect(refused.status, method).toBe(403);
    }

    expect(handle.logger.level).toBe("error");
  });

  it("streams a published domain event to a connected WS client", async () => {
    const { handle, config } = boot();

    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, {
      headers: { origin: loopbackOrigin(config.port) },
    });

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
        if (messages.length === 1) {
          handle.bus.publish({
            entity: "workstream",
            verb: "created",
            workstream: {
              id: "ws_1" as never,
              subjectId: null,
              status: "active",
              archivedAt: null,
              createdAt: 0,
            },
            author: humanAuthor,
          });
        }
        if (messages.length === 2) resolve();
      });
    });

    ws.close();

    expect(messages[0]).toMatchObject({ type: "hello" });
    expect(messages[1]).toMatchObject({
      type: "event",
      event: { entity: "workstream", verb: "created" },
    });
  });

  it("refuses a WS upgrade from an untrusted origin", async () => {
    const { config } = boot();

    const rejection = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, {
        headers: { origin: "https://evil.example.com" },
      });
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode);
        ws.terminate();
      });
      ws.on("error", () => resolve(undefined));
    });

    expect(rejection).toBe(403);
  });

  it("refuses a WS upgrade missing the required credential", async () => {
    const { config } = boot({ credential: "s3cret" });

    const rejection = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, {
        headers: { origin: loopbackOrigin(config.port) },
      });
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode);
        ws.terminate();
      });
      ws.on("error", () => resolve(undefined));
    });

    expect(rejection).toBe(401);
  });

  it("accepts a WS upgrade carrying the credential as a query param", async () => {
    const { config } = boot({ credential: "s3cret" });

    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${config.port}/ws?credential=s3cret`,
        { headers: { origin: loopbackOrigin(config.port) } },
      );
      ws.on("open", () => {
        resolve(true);
        ws.close();
      });
      ws.on("unexpected-response", () => resolve(false));
      ws.on("error", () => resolve(false));
    });

    expect(opened).toBe(true);
  });

  it("refuses to start bound non-loopback without opt-in and credential", () => {
    const config = testConfig({ host: "0.0.0.0" });
    expect(() => startServer(config)).toThrow(/refusing to bind/);
    rmSync(config.stateDir, { recursive: true, force: true });
  });
});
