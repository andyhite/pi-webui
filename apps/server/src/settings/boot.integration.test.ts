import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, afterEach, describe, it } from "bun:test";
import { loadServerConfig, type ServerConfigOverrides } from "../config.js";
import { startServer } from "../index.js";
import { ephemeralPort, occupyPort } from "../testing/ports.js";

/**
 * Blocking finding #1: persisted host/port/allowNonLoopbackBind overrides
 * must actually take effect on the *next* boot — `checkBindPolicy` and
 * `serve()` read the layered effective config, not the caller's raw one.
 *
 * Every test here calls `startServer` directly rather than through
 * `testing/harness.ts`'s `boot()`: that helper assumes the port it hands
 * `loadServerConfig` is the port the server ends up bound to, which is
 * exactly the assumption these tests exist to falsify (a stored override can
 * make the *effective* port, host, or bind policy different from what the
 * caller passed in).
 */

const scratch: string[] = [];
const handles: ReturnType<typeof startServer>[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plotroom-boot-settings-"));
  scratch.push(dir);
  return dir;
}

async function boot(overrides: ServerConfigOverrides) {
  const handle = startServer(loadServerConfig({}, overrides));
  handles.push(handle);
  // The bound port, awaited before anything fetches: under `port: 0` it is the
  // only way to know where to send a request, and for the one test that must name
  // its ports up front it is what turns a port something else took between the
  // probe and the bind into a failure here, rather than an unhandled `error`
  // event for a later assertion to trip over.
  const { port } = await handle.listening;
  await handle.recovered;
  return { handle, port };
}

function baseOverrides(dir: string, port: number): ServerConfigOverrides {
  return {
    host: "127.0.0.1",
    port,
    stateDir: dir,
    credential: null,
    allowNonLoopbackBind: false,
    trustedOrigins: [],
    staticDir: join(tmpdir(), "plotroom-no-such-renderer-dir"),
    logLevel: "error",
    pluginsInBox: [],
    runtime: { adapterId: "scripted" },
    workspace: { kind: "git", directory: join(dir, "workspaces") },
  };
}

describe("persisted host/port/allowNonLoopbackBind take effect on the next boot (§12, §11)", () => {
  it("binds the stored port, not the one the caller's config asked for", async () => {
    const dir = stateDir();
    // The one place in this file that cannot ask for port 0: a *stored* port
    // beating the caller's config is the behaviour under test, so both numbers
    // have to exist before either server boots.
    const firstPort = await ephemeralPort();
    const storedPort = await ephemeralPort();

    const { handle: first } = await boot(baseOverrides(dir, firstPort));
    const written = await fetch(
      `http://127.0.0.1:${firstPort}/api/settings/port`,
      {
        method: "PUT",
        headers: {
          origin: `http://localhost:${firstPort}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: storedPort }),
      },
    );
    expect(written.status).toBe(200);
    await first.close();
    handles.pop();

    // The second boot is asked for `firstPort` again — a free port, since
    // the first server just released it — but the stored override should
    // win, and the server should actually be listening on `storedPort`.
    const { handle: second } = await boot(baseOverrides(dir, firstPort));

    const onStoredPort = await fetch(
      `http://127.0.0.1:${storedPort}/api/health`,
      { headers: { origin: `http://localhost:${storedPort}` } },
    );
    expect(onStoredPort.status).toBe(200);

    // Nothing is listening on the port the config asked for: the stored
    // override replaced it rather than merely being visible alongside it.
    await expect(
      fetch(`http://127.0.0.1:${firstPort}/api/health`, {
        headers: { origin: `http://localhost:${firstPort}` },
      }),
    ).rejects.toBeDefined();

    void second;
  });

  it("sees a stored allowNonLoopbackBind and credential together, exactly as the running app does (§12)", async () => {
    const dir = stateDir();
    // Nothing here names a port: both boots take whatever the OS has, and say
    // which they got. What is under test is the *other* three stored settings.
    const { handle: first, port: firstPort } = await boot(
      baseOverrides(dir, 0),
    );
    for (const [key, value] of [
      ["allowNonLoopbackBind", true],
      ["credential", "s3cret"],
    ] as const) {
      const res = await fetch(
        `http://127.0.0.1:${firstPort}/api/settings/${key}`,
        {
          method: "PUT",
          headers: {
            origin: `http://localhost:${firstPort}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ value }),
        },
      );
      expect(res.status, key).toBe(200);
    }
    await first.close();
    handles.pop();

    // The second boot's own config says the opposite of both stored
    // overrides — non-loopback with neither the opt-in nor a credential,
    // which `checkBindPolicy` refuses on its own. If the bind check reads
    // the stored values (the fix), it does not throw; if it reads this raw
    // config instead (the bug), `startServer` throws before returning.
    const { handle: second, port: secondPort } = await boot({
      ...baseOverrides(dir, 0),
      host: "0.0.0.0",
      allowNonLoopbackBind: false,
      credential: null,
    });

    // The credential middleware already reads the same effective config
    // (`LiveSecurityPolicy`): a request naming it succeeds, and one that
    // does not is refused — proof the boot-time check and the running app
    // agree about what the credential actually is.
    const noAuth = await fetch(`http://127.0.0.1:${secondPort}/api/health`, {
      headers: { origin: `http://localhost:${secondPort}` },
    });
    expect(noAuth.status).toBe(401);

    const withAuth = await fetch(`http://127.0.0.1:${secondPort}/api/health`, {
      headers: {
        origin: `http://localhost:${secondPort}`,
        authorization: "Bearer s3cret",
      },
    });
    expect(withAuth.status).toBe(200);

    void second;
  });
});

/**
 * #87: a stored `port` that is *legal* — it passes `checkBindPolicy` and the
 * catalog's bound — can still be unbindable on this machine (already taken by
 * something else). No bound can catch that ahead of time; only a failed
 * `listen()` can, and boot must fall back to the env-derived default rather
 * than exit on every subsequent boot.
 */
describe("a stored host/port that is legal but unbindable falls back and is reported (#87)", () => {
  it("binds the env-derived port instead, and reports the stored one as ignored", async () => {
    const dir = stateDir();
    const firstPort = await ephemeralPort();
    const occupiedPort = await ephemeralPort();

    const { handle: first } = await boot(baseOverrides(dir, firstPort));
    const written = await fetch(
      `http://127.0.0.1:${firstPort}/api/settings/port`,
      {
        method: "PUT",
        headers: {
          origin: `http://localhost:${firstPort}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: occupiedPort }),
      },
    );
    expect(written.status).toBe(200);
    await first.close();
    handles.pop();

    // Something else holds `occupiedPort` for the whole of the second boot —
    // occupied on both stacks (#343): a caller resolving `127.0.0.1` here is
    // the only one this test's own config uses, but `occupyPort` covers
    // `::1` too so this blocker means the same thing on every platform.
    const blocker = await occupyPort(occupiedPort);
    try {
      // Asked for `firstPort` again (free, since the first server released
      // it) — the stored override still wins the *attempt*, but it cannot
      // bind, so the server ends up on the env-derived default rather than
      // failing to start at all.
      const { handle: second, port: secondPort } = await boot(
        baseOverrides(dir, firstPort),
      );
      expect(secondPort).toBe(firstPort);

      const report = await fetch(
        `http://127.0.0.1:${firstPort}/api/settings/port`,
        { headers: { origin: `http://localhost:${firstPort}` } },
      );
      const body = (await report.json()) as {
        setting: { overridden: boolean; ignoredReason?: string };
      };
      expect(body.setting.overridden).toBe(false);
      expect(body.setting.ignoredReason).toMatch(
        new RegExp(`${occupiedPort}.*could not be bound`),
      );

      void second;
    } finally {
      await blocker.close();
    }
  });

  it("attributes an unbindable port to the port alone, leaving a good host override standing", async () => {
    // Both `host` and `port` are stored overrides here, and only one of them
    // is actually the reason the bind fails — a single combined OS error
    // cannot say which, so this proves the fallback isolates it rather than
    // discarding a perfectly good override alongside the bad one.
    const dir = stateDir();
    const firstPort = await ephemeralPort();
    const occupiedPort = await ephemeralPort();

    const { handle: first } = await boot(baseOverrides(dir, firstPort));
    for (const [key, value] of [
      ["host", "localhost"],
      ["port", occupiedPort],
    ] as const) {
      const res = await fetch(
        `http://127.0.0.1:${firstPort}/api/settings/${key}`,
        {
          method: "PUT",
          headers: {
            origin: `http://localhost:${firstPort}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ value }),
        },
      );
      expect(res.status, key).toBe(200);
    }
    await first.close();
    handles.pop();

    // `localhost` resolves dual-stack on this machine (IPv6 `::1` ahead of
    // `127.0.0.1`), so a blocker bound to one alone would leave the stored
    // port bindable on the other. `createServer().listen(port)` with no
    // host binds `::` only, and whether that also covers IPv4 depends on
    // `net.ipv6.bindv6only` — true on macOS (#343: this test failed 4/4
    // runs there, since the port was never actually occupied on IPv4),
    // false on the Linux CI runners this test has only ever run on.
    // `occupyPort` binds both explicitly instead, so this means the same
    // thing on every platform.
    const blocker = await occupyPort(occupiedPort);
    try {
      const { handle: second, port: secondPort } = await boot(
        baseOverrides(dir, firstPort),
      );
      expect(secondPort).toBe(firstPort);

      // The bound host is the overridden "localhost", not "127.0.0.1" —
      // fetch through the same name so this resolves to whichever address
      // (`::1` or `127.0.0.1`) actually ended up listening.
      const hostReport = await fetch(
        `http://localhost:${firstPort}/api/settings/host`,
        { headers: { origin: `http://localhost:${firstPort}` } },
      );
      const hostBody = (await hostReport.json()) as {
        setting: { overridden: boolean; ignoredReason?: string };
      };
      // The host override was never at fault, so it is still in effect —
      // reverting only the port already fixed the bind.
      expect(hostBody.setting.overridden).toBe(true);
      expect(hostBody.setting.ignoredReason).toBeUndefined();

      const portReport = await fetch(
        `http://localhost:${firstPort}/api/settings/port`,
        { headers: { origin: `http://localhost:${firstPort}` } },
      );
      const portBody = (await portReport.json()) as {
        setting: { overridden: boolean; ignoredReason?: string };
      };
      expect(portBody.setting.overridden).toBe(false);
      expect(portBody.setting.ignoredReason).toMatch(
        new RegExp(`${occupiedPort}.*could not be bound`),
      );

      void second;
    } finally {
      await blocker.close();
    }
  });

  it("still fails a boot whose own config (not a stored override) cannot bind", async () => {
    // Unchanged behaviour for the case #87 does not cover: nothing was
    // overridden, so there is nothing to fall back to beyond what the caller
    // already asked for.
    const dir = stateDir();
    const port = await ephemeralPort();
    const { handle: first } = await boot(baseOverrides(dir, port));

    const collision = startServer(
      loadServerConfig({}, baseOverrides(stateDir(), port)),
    );
    handles.push(collision);
    await expect(collision.listening).rejects.toMatchObject({
      code: "EADDRINUSE",
    });

    void first;
  });
});

/**
 * A refused boot should leave nothing behind. The bind policy must still be
 * checked against the *effective* config for a state directory that exists
 * (the suite above is what proves that), so the early answer is only taken
 * when there is provably nowhere for an override to live yet.
 */
describe("a refused boot creates no state (§12)", () => {
  it("refuses a first boot before creating or migrating the state directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "plotroom-refused-boot-"));
    scratch.push(parent);
    const dir = join(parent, "state");
    // No port at all: this boot is refused before it reaches the socket, so a
    // probed one would only be a port taken off the machine for nothing.
    const port = 0;

    // Non-loopback with neither the opt-in nor a credential: refused by
    // `checkBindPolicy` on its own, and no stored setting could say otherwise
    // because there is no store.
    expect(() =>
      startServer(
        loadServerConfig(
          {},
          {
            ...baseOverrides(dir, port),
            host: "0.0.0.0",
          },
        ),
      ),
    ).toThrow(/loopback|credential/i);

    // Nothing was created: no directory, so no database and no blobs tree.
    expect(existsSync(dir)).toBe(false);
  });

  it("still refuses on the effective config once a state directory exists, and leaves it as it found it", async () => {
    const dir = stateDir();
    const port = 0;

    // A first, legal boot creates the state directory.
    const { handle: first } = await boot(baseOverrides(dir, port));
    await first.close();
    handles.pop();
    expect(existsSync(join(dir, "plotroom.db"))).toBe(true);

    // The second boot's config is refused — read from the store this time,
    // since the store exists and could have said otherwise.
    expect(() =>
      startServer(
        loadServerConfig(
          {},
          {
            ...baseOverrides(dir, port),
            host: "0.0.0.0",
          },
        ),
      ),
    ).toThrow(/loopback|credential/i);

    // The directory it found is still there: a refusal removes nothing
    // (principle 10), it just does not add anything either.
    expect(existsSync(join(dir, "plotroom.db"))).toBe(true);
  });
});
