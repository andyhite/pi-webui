import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadServerConfig, type ServerConfigOverrides } from "../config.js";
import { startServer } from "../index.js";
import { ephemeralPort } from "../testing/harness.js";

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
  await handle.recovered;
  return handle;
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
    const firstPort = await ephemeralPort();
    const storedPort = await ephemeralPort();

    const first = await boot(baseOverrides(dir, firstPort));
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
    const second = await boot(baseOverrides(dir, firstPort));

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
    const firstPort = await ephemeralPort();

    const first = await boot(baseOverrides(dir, firstPort));
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
    const secondPort = await ephemeralPort();
    const second = await boot({
      ...baseOverrides(dir, secondPort),
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
    const port = await ephemeralPort();

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
    const port = await ephemeralPort();

    // A first, legal boot creates the state directory.
    const first = await boot(baseOverrides(dir, port));
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
