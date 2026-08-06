import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanAuthor } from "@plotroom/core";
import { expect, afterEach, describe, it } from "bun:test";
import { loadServerConfig, type ServerConfig } from "./config.js";
import { startServer } from "./index.js";

/**
 * Every boot here asks for port 0 and reads back the port it actually bound, so
 * the config these tests assert against is the one the socket is on.
 *
 * The pool of probed ports this replaced could not be right: a probe has to close
 * its socket before the server can bind, and in that window a leaked server or a
 * parallel suite can take the port — and the failure is not always a clean
 * EADDRINUSE, it can be requests landing on the other server, surfacing far away
 * as something else. Reserving twenty-four of them up front only widened the
 * window to the whole file.
 */

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const stateDir = mkdtempSync(join(tmpdir(), "plotroom-server-test-"));
  return loadServerConfig(
    {},
    {
      host: "127.0.0.1",
      port: 0,
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

async function boot(overrides: Partial<ServerConfig> = {}): Promise<{
  handle: Handle;
  config: ServerConfig;
}> {
  const config = testConfig(overrides);
  const handle = startServer(config);
  handles.push(handle);
  // The config is returned with the *bound* port in it, not the `0` that was
  // asked for — so `config.port` still means "where this server is", which is
  // what every call site below reads it as. Awaiting it also puts a bind failure
  // on this line rather than leaving it an unhandled `error` event.
  const { port } = await handle.listening;
  return { handle, config: { ...config, port } };
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
    const { config } = await boot();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
      headers: { origin: loopbackOrigin(config.port) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("reports the port it actually bound, not the one it was asked for", async () => {
    // The whole reason `listening` exists: a caller asking for 0 has no way to
    // learn the port from its own config, and every test harness in this repo
    // needs it. A `startServer` that echoed the request back would report `0`.
    const config = testConfig();
    expect(config.port).toBe(0);

    const handle = startServer(config);
    handles.push(handle);
    const bound = await handle.listening;

    // The port, and only the port: for a loopback boot the socket's own
    // `address` and the configured host are the same string, so asserting the
    // host here could not tell the two apart and would pass either way.
    expect(bound.port).toBeGreaterThan(0);
    expect(bound.port).not.toBe(config.port);
    const res = await fetch(`http://127.0.0.1:${bound.port}/api/health`, {
      headers: { origin: loopbackOrigin(bound.port) },
    });
    expect(res.status).toBe(200);
  });

  it("reports a port it could not bind, rather than dying of an unwatched error", async () => {
    // A bind failure lands after `startServer` has returned, so it cannot be
    // thrown: before `listening` it was an `error` event with no listener, which
    // takes the whole process down with a stack trace pointing at nothing the
    // caller did. Under `port: 0` this is unreachable — which is why every
    // harness now asks for 0 — but a configured port can always be taken.
    const occupied = await boot();
    const collision = startServer(testConfig({ port: occupied.config.port }));
    handles.push(collision);

    await expect(collision.listening).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });

  it("refuses a non-loopback, non-allow-listed origin with the consistent error shape", async () => {
    const { config } = await boot();
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
    const { config } = await boot({ credential: "s3cret" });
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
    const { config } = await boot();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/nope`, {
      headers: { origin: loopbackOrigin(config.port) },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });

  it("reports 503 with a clear message when the renderer has not been built", async () => {
    const { config } = await boot();
    const res = await fetch(`http://127.0.0.1:${config.port}/`, {
      headers: { origin: loopbackOrigin(config.port) },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("renderer_not_built");
  });

  it("adjusts the log level at runtime via PATCH /api/log-level, validated", async () => {
    const { handle, config } = await boot();

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
    const { handle, config } = await boot();

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
    const { handle, config } = await boot();

    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, {
      headers: { origin: loopbackOrigin(config.port) },
    });

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("error", reject);
      ws.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
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
    const { config } = await boot();

    const rejection = await fetch(`http://127.0.0.1:${config.port}/ws`, {
      headers: { origin: "https://evil.example.com" },
    }).then((response) => response.status);

    expect(rejection).toBe(403);
  });

  it("refuses a WS upgrade missing the required credential", async () => {
    const { config } = await boot({ credential: "s3cret" });

    const rejection = await fetch(`http://127.0.0.1:${config.port}/ws`, {
      headers: { origin: loopbackOrigin(config.port) },
    }).then((response) => response.status);

    expect(rejection).toBe(401);
  });

  it("accepts a WS upgrade carrying the credential as a query param", async () => {
    const { config } = await boot({ credential: "s3cret" });

    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${config.port}/ws?credential=s3cret`,
        { headers: { origin: loopbackOrigin(config.port) } },
      );
      ws.addEventListener("open", () => {
        resolve(true);
        ws.close();
      });
      ws.addEventListener("error", () => resolve(false));
    });

    expect(opened).toBe(true);
  });

  it("refuses to start bound non-loopback without opt-in and credential", () => {
    const config = testConfig({ host: "0.0.0.0" });
    expect(() => startServer(config)).toThrow(/refusing to bind/);
    rmSync(config.stateDir, { recursive: true, force: true });
  });
});
