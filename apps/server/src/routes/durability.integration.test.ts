import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  humanAuthor,
  readinessProvisioned,
  type DomainEvent,
} from "@plotroom/core";
import { openDatabase, WorkspaceStore, WorkstreamStore } from "@plotroom/db";
import { loadServerConfig, type ServerConfigOverrides } from "../config.js";
import { startServer } from "../index.js";
import { ephemeralPort } from "../testing/harness.js";

/**
 * Durability and portability over the real app (Epic 2.3, §12).
 *
 * "All state in the single portable store; survives restart; backup/move story."
 * The only way to believe that sentence is to move a state directory and see the
 * product come up with the same board, which is what the first test here does —
 * copying the directory to a new path, on a new port, and asserting the snapshot
 * is identical and the content is still readable.
 */
/**
 * Ports come from the OS, not from a counter. A static band collides with a leaked
 * server or another suite, and the failure is not always a clean EADDRINUSE — it can
 * be requests landing on the other server, which surfaces far away as something
 * else. `ephemeralPort` is the shared bind probe.
 */

interface Harness {
  readonly handle: ReturnType<typeof startServer>;
  readonly stateDir: string;
  readonly port: number;
  call(path: string, options?: CallOptions): Promise<CallResult>;
  ok(path: string, options?: CallOptions): Promise<unknown>;
}

interface CallOptions {
  readonly method?: string;
  readonly body?: unknown;
}

interface CallResult {
  readonly status: number;
  readonly body: unknown;
}

const harnesses: Harness[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.handle.close();
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function boot(
  overrides: ServerConfigOverrides = {},
  options: { readonly stateDir?: string } = {},
): Promise<Harness> {
  const stateDir =
    options.stateDir ?? mkdtempSync(join(tmpdir(), "plotroom-durable-"));
  if (options.stateDir === undefined) scratch.push(stateDir);
  mkdirSync(join(stateDir, "workspaces"), { recursive: true });

  const thisPort = await ephemeralPort();
  const handle = startServer(
    loadServerConfig(
      {},
      {
        host: "127.0.0.1",
        port: thisPort,
        stateDir,
        credential: null,
        allowNonLoopbackBind: false,
        trustedOrigins: [],
        staticDir: join(tmpdir(), "plotroom-no-such-renderer-dir"),
        logLevel: "error",
        // The sweep is driven explicitly here; a schedule would make these
        // tests depend on wall-clock time.
        compactionIntervalSeconds: 0,
        // No plugin workers: these suites assert nothing about plugins, and a
        // worker per in-box plugin per boot is time nothing here spends usefully.
        pluginsInBox: [],
        ...overrides,
        workspace: {
          kind: "git",
          directory: join(stateDir, "workspaces"),
          ...overrides.workspace,
        },
      },
    ),
  );
  await handle.recovered;

  const base = `http://127.0.0.1:${thisPort}/api`;
  const origin = `http://localhost:${thisPort}`;

  const call = async (
    path: string,
    callOptions: CallOptions = {},
  ): Promise<CallResult> => {
    const res = await fetch(`${base}${path}`, {
      method: callOptions.method ?? "GET",
      headers: { origin, "content-type": "application/json" },
      ...(callOptions.body !== undefined
        ? { body: JSON.stringify(callOptions.body) }
        : {}),
    });
    return { status: res.status, body: await res.json() };
  };

  const harness: Harness = {
    handle,
    stateDir,
    port: thisPort,
    call,
    async ok(path, callOptions) {
      const res = await call(path, callOptions);
      if (res.status >= 300) {
        throw new Error(
          `${path} failed: ${res.status} ${JSON.stringify(res.body)}`,
        );
      }
      return res.body;
    },
  };

  harnesses.push(harness);
  return harness;
}

function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) => (current as Record<string, unknown>)?.[key],
      value,
    );
}

function str(value: unknown, path: string): string {
  const found = at(value, path);
  if (typeof found !== "string") {
    throw new Error(
      `expected a string at ${path}, got ${JSON.stringify(found)}`,
    );
  }
  return found;
}

function list(value: unknown, path: string): unknown[] {
  const found = at(value, path);
  if (!Array.isArray(found)) {
    throw new Error(
      `expected an array at ${path}, got ${JSON.stringify(found)}`,
    );
  }
  return found;
}

/** A workstream, a note, its node, and a command wired to it. */
async function board(harness: Harness) {
  const workstream = str(
    await harness.ok("/workstreams", { method: "POST", body: {} }),
    "workstream.id",
  );
  const note = await harness.ok("/notes", {
    method: "POST",
    body: { title: "ticket", body: "the content", workstreamId: workstream },
  });
  const node = await harness.ok("/nodes", {
    method: "POST",
    body: {
      role: "content",
      refId: str(note, "object.id"),
      workstreamId: workstream,
    },
  });

  return {
    workstream,
    objectId: str(note, "object.id"),
    nodeId: str(node, "node.id"),
  };
}

describe("the single portable state directory (§12)", () => {
  it("names what to back up, and what is deliberately not in it", async () => {
    const harness = await boot();
    await board(harness);

    const state = await harness.ok("/maintenance/state");

    expect(at(state, "portable.unit")).toBe(harness.stateDir);
    expect(list(state, "portable.includes")).toEqual([
      join(harness.stateDir, "plotroom.db"),
      join(harness.stateDir, "blobs"),
    ]);
    // Derived directories live inside the state dir but are not part of the
    // backup unit, and each says why (§12, principle 12).
    const excluded = list(state, "portable.excludes");
    expect(excluded.map((entry) => at(entry, "path"))).toContain(
      join(harness.stateDir, "workspaces"),
    );
    for (const entry of excluded) {
      expect(str(entry, "why").length).toBeGreaterThan(0);
    }
    expect(at(state, "inventory.schemaVersion")).toBeGreaterThanOrEqual(8);
    expect(at(state, "inventory.counts.objects")).toBe(1);
  });

  it("boots identically from a moved copy of the state directory", async () => {
    const first = await boot();
    const made = await board(first);
    await first.ok(`/nodes/${made.nodeId}/position`, {
      method: "PATCH",
      body: { position: { x: 42, y: -7 } },
    });

    const before = await first.ok("/snapshot");
    const content = await first.ok(`/objects/${made.objectId}`);

    await first.handle.close();
    harnesses.splice(harnesses.indexOf(first), 1);

    // The move: copy the two things the product says are the backup unit, into
    // a directory with a different name, and start on a different port.
    const moved = mkdtempSync(join(tmpdir(), "plotroom-moved-"));
    scratch.push(moved);
    cpSync(join(first.stateDir, "plotroom.db"), join(moved, "plotroom.db"));
    cpSync(join(first.stateDir, "blobs"), join(moved, "blobs"), {
      recursive: true,
    });

    const second = await boot({}, { stateDir: moved });
    const after = await second.ok("/snapshot");

    // Same board, same arrangement, same content — the only difference is the
    // event sequence, which is per process and never persisted (Epic 2.1).
    expect(at(after, "workstreams")).toEqual(at(before, "workstreams"));
    expect(at(after, "nodes")).toEqual(at(before, "nodes"));
    expect(at(after, "objects")).toEqual(at(before, "objects"));
    expect(at(after, "commandDefinitions")).toEqual(
      at(before, "commandDefinitions"),
    );
    expect(
      list(after, "nodes").find((node) => at(node, "id") === made.nodeId),
    ).toMatchObject({ position: { x: 42, y: -7 } });
    expect(await second.ok(`/objects/${made.objectId}`)).toEqual(content);
  });
});

describe("durable placement (§5, Epic 3.1)", () => {
  it("keeps an arrangement across a restart, and announces every move", async () => {
    const harness = await boot();
    const made = await board(harness);

    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`, {
      headers: { origin: `http://localhost:${harness.port}` },
    });
    const events: DomainEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          type: string;
          event?: DomainEvent;
        };
        if (message.type === "hello") resolve();
        if (message.type === "event" && message.event) {
          events.push(message.event);
        }
      });
    });

    const placed = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: made.objectId,
        workstreamId: made.workstream,
      },
    });
    expect(at(placed, "node.position")).toBeNull();

    const moved = await harness.ok(`/nodes/${made.nodeId}/position`, {
      method: "PATCH",
      body: { position: { x: 12.5, y: 90 } },
    });
    expect(at(moved, "node.position")).toEqual({ x: 12.5, y: 90 });

    await harness.ok("/arrangement", {
      method: "PATCH",
      body: { positions: [{ nodeId: made.nodeId, position: { x: 1, y: 2 } }] },
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    ws.close();

    // A move is a mutation like any other, and it travels on the one vocabulary
    // with the full node — a subscriber needs no follow-up fetch (§2.1).
    const positions = events
      .filter((event) => event.entity === "node" && event.verb === "updated")
      .map((event) => at(event, "node.position"));
    expect(positions).toEqual([
      { x: 12.5, y: 90 },
      { x: 1, y: 2 },
    ]);

    // Durable: a restart on the same state directory still knows where it is.
    await harness.handle.close();
    harnesses.splice(harnesses.indexOf(harness), 1);
    const restarted = await boot({}, { stateDir: harness.stateDir });
    const snapshot = await restarted.ok("/snapshot");

    expect(
      list(snapshot, "nodes").find((node) => at(node, "id") === made.nodeId),
    ).toMatchObject({ position: { x: 1, y: 2 } });
  });

  it("refuses a whole arrangement that names a node it cannot find", async () => {
    const harness = await boot();
    const made = await board(harness);
    await harness.ok(`/nodes/${made.nodeId}/position`, {
      method: "PATCH",
      body: { position: { x: 5, y: 5 } },
    });

    const res = await harness.call("/arrangement", {
      method: "PATCH",
      body: {
        positions: [
          { nodeId: made.nodeId, position: { x: 99, y: 99 } },
          { nodeId: "node_missing", position: { x: 1, y: 1 } },
        ],
      },
    });

    expect(res.status).toBe(404);
    // Nothing moved: a half-applied arrangement is not what was asked for.
    const node = await harness.ok(`/nodes/${made.nodeId}`);
    expect(at(node, "node.position")).toEqual({ x: 5, y: 5 });
  });
});

describe("reset states what it removes first (§12)", () => {
  it("plans every scope without removing anything", async () => {
    const harness = await boot();
    const made = await board(harness);
    await harness.ok(`/nodes/${made.nodeId}/position`, {
      method: "PATCH",
      body: { position: { x: 3, y: 4 } },
    });

    for (const scope of ["arrangement", "derived", "everything"] as const) {
      const planned = await harness.ok(`/reset/plan?scope=${scope}`);
      expect(at(planned, "plan.scope")).toBe(scope);
      expect(list(planned, "plan.removes").length).toBeGreaterThan(0);
      expect(list(planned, "plan.keeps").length).toBeGreaterThan(0);
    }

    // Reading a plan removes nothing.
    const node = await harness.ok(`/nodes/${made.nodeId}`);
    expect(at(node, "node.position")).toEqual({ x: 3, y: 4 });
    expect(list(await harness.ok("/snapshot"), "objects")).toHaveLength(1);
  });

  it("refuses an unknown scope rather than guessing one", async () => {
    const harness = await boot();
    const res = await harness.call("/reset/plan?scope=some-of-it");

    expect(res.status).toBe(400);
    expect(str(res.body, "error.message")).toMatch(/scope must be one of/);
  });

  it("answers an unconfirmed reset with the plan, and removes nothing", async () => {
    const harness = await boot();
    const made = await board(harness);
    await harness.ok(`/nodes/${made.nodeId}/position`, {
      method: "PATCH",
      body: { position: { x: 3, y: 4 } },
    });

    const answer = await harness.ok("/reset", {
      method: "POST",
      body: { scope: "everything" },
    });

    expect(at(answer, "confirmed")).toBe(false);
    expect(at(answer, "removed")).toBeNull();
    expect(list(answer, "plan.removes")[0]).toMatch(/every row in the store/);

    // Still all there: the plan is the contract, and it was not accepted.
    expect(list(await harness.ok("/snapshot"), "objects")).toHaveLength(1);
    const node = await harness.ok(`/nodes/${made.nodeId}`);
    expect(at(node, "node.position")).toEqual({ x: 3, y: 4 });
  });

  it("clears only the arrangement when that is the scope", async () => {
    const harness = await boot();
    const made = await board(harness);
    await harness.ok(`/nodes/${made.nodeId}/position`, {
      method: "PATCH",
      body: { position: { x: 3, y: 4 } },
    });

    const done = await harness.ok("/reset", {
      method: "POST",
      body: { scope: "arrangement", confirm: true },
    });

    expect(at(done, "confirmed")).toBe(true);
    expect(at(done, "result.removed.arrangedNodes")).toBe(1);
    // No directory is touched for an arrangement reset, and it says so by
    // listing none.
    expect(list(done, "result.removedPaths")).toEqual([]);

    const node = await harness.ok(`/nodes/${made.nodeId}`);
    expect(at(node, "node.position")).toBeNull();
    // The board itself is untouched.
    expect(list(await harness.ok("/snapshot"), "objects")).toHaveLength(1);
    expect(list(await harness.ok("/snapshot"), "nodes")).toHaveLength(1);
  });

  it("names sessions still in flight before it deletes their records", async () => {
    const harness = await boot();
    await board(harness);

    // With nothing running, the plan says nothing about sessions.
    const quiet = await harness.ok("/reset/plan?scope=everything");
    expect(at(quiet, "plan.counts.liveSessions")).toBe(0);
    expect(list(quiet, "plan.removes").join(" ")).not.toMatch(/in flight/);
  });

  it("empties the store when everything is confirmed, and stays usable", async () => {
    const harness = await boot();
    await board(harness);

    const done = await harness.ok("/reset", {
      method: "POST",
      body: { scope: "everything", confirm: true },
    });

    expect(at(done, "confirmed")).toBe(true);
    expect(at(done, "result.removed.objects")).toBe(1);
    expect(at(done, "result.removed.blobs")).toBeGreaterThan(0);

    const snapshot = await harness.ok("/snapshot");
    expect(list(snapshot, "objects")).toEqual([]);
    expect(list(snapshot, "workstreams")).toEqual([]);
    expect(list(snapshot, "nodes")).toEqual([]);

    // Emptied, not broken: the schema is still there to write into.
    await harness.ok("/workstreams", { method: "POST", body: {} });
    expect(list(await harness.ok("/snapshot"), "workstreams")).toHaveLength(1);
  });

  it("removes the derived directories, and says which ones it removed", async () => {
    const harness = await boot();
    const derived = join(harness.stateDir, "git-cache");
    mkdirSync(derived, { recursive: true });

    const done = await harness.ok("/reset", {
      method: "POST",
      body: { scope: "derived", confirm: true },
    });

    expect(list(done, "result.removedPaths")).toContain(derived);
    expect(existsSync(derived)).toBe(false);
  });
});

describe("compaction on demand (§15-3, Epic 2.3)", () => {
  it("sweeps when asked, and reports what it removed", async () => {
    const harness = await boot();
    const made = await board(harness);

    // A second version of the note: the first becomes an unreferenced
    // intermediate, and is still inside the window, so nothing goes yet.
    await harness.ok(`/notes/${made.objectId}`, {
      method: "PATCH",
      body: { body: "the content, revised" },
    });

    const swept = await harness.ok("/maintenance/compact", { method: "POST" });

    expect(at(swept, "compaction.versionsRemoved")).toBe(0);
    expect(at(swept, "compaction.runsRemoved")).toBe(0);
    expect(typeof at(swept, "compaction.bytesFreed")).toBe("number");

    // Both versions are still readable: nothing inside the window is touched.
    expect(
      list(await harness.ok(`/objects/${made.objectId}/versions`), "versions"),
    ).toHaveLength(2);
  });

  it("reports the schedule the operator configured", async () => {
    const harness = await boot({ compactionIntervalSeconds: 1_800 });
    const state = await harness.ok("/maintenance/state");

    expect(at(state, "compaction.intervalSeconds")).toBe(1_800);
  });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV }).toString();
}

/**
 * A real checkout with a real upstream: an origin repository with one commit,
 * cloned to `path`. Real because the dirty check asks git, and because
 * "unpushed" only means anything against an upstream that exists.
 */
function gitCheckoutAt(path: string): void {
  const origin = `${path}-origin`;
  mkdirSync(origin, { recursive: true });

  git(origin, "init", "--initial-branch", "feat/thing");
  git(origin, "config", "user.email", "test@plotroom.invalid");
  git(origin, "config", "user.name", "PlotRoom Test");
  writeFileSync(join(origin, "README.md"), "# fixture\n", "utf8");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "initial");

  mkdirSync(path, { recursive: true });
  git(path, "clone", origin, ".");
  git(path, "config", "user.email", "test@plotroom.invalid");
  git(path, "config", "user.name", "PlotRoom Test");
}

/** A commit that exists only in this checkout — the scariest thing to delete. */
function commitLocally(path: string, file: string): void {
  writeFileSync(join(path, file), "local only\n", "utf8");
  git(path, "add", file);
  git(path, "commit", "-m", "not pushed");
}

/**
 * A provisioned workspace record pointing at a real checkout, written directly.
 * Provisioning through a run would need a runtime and prove nothing extra: what
 * is under test is the *plan's* honesty about a checkout that already exists.
 */
function seedProvisionedWorkspace(stateDir: string, checkout: string): string {
  gitCheckoutAt(checkout);

  const state = openDatabase({ stateDir });
  try {
    const workstream = new WorkstreamStore(state).create({
      author: humanAuthor,
    });
    const workspaces = new WorkspaceStore(state);
    const workspace = workspaces.create({
      workstreamId: workstream.id,
      kind: "git",
      config: { workspacePath: checkout, repositoryPath: checkout },
      author: humanAuthor,
    });

    workspaces.recordProvisioned(workspace.id, {
      roots: [
        {
          key: "root",
          path: checkout,
          branch: "feat/thing",
          primaryCheckout: false,
        },
      ],
      cost: {
        elapsedMillis: 1,
        bytesOnDisk: null,
        sharedCache: "hit",
        strategy: "worktree",
      },
      readiness: readinessProvisioned(workspace.readiness, null, 0),
    });

    return workspace.id;
  } finally {
    state.close();
  }
}

describe("a reset plan names the work only a checkout holds (§12)", () => {
  it("names uncommitted, untracked, and unpushed work per checkout", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-dirty-"));
    scratch.push(stateDir);
    const checkout = join(stateDir, "workspaces", "ws-under-test");
    const workspaceId = seedProvisionedWorkspace(stateDir, checkout);

    // Work that exists nowhere else: a local commit, an edit, and a new file.
    commitLocally(checkout, "local.txt");
    writeFileSync(join(checkout, "README.md"), "# edited\n", "utf8");
    writeFileSync(join(checkout, "notes.txt"), "scratch\n", "utf8");

    const harness = await boot({}, { stateDir });
    const planned = await harness.ok("/reset/plan?scope=derived");

    const dirty = list(planned, "plan.dirtyWorkspaces");
    expect(dirty).toHaveLength(1);
    expect(at(dirty[0], "workspaceId")).toBe(workspaceId);
    expect(at(dirty[0], "path")).toBe(checkout);
    expect(at(dirty[0], "branch")).toBe("feat/thing");
    expect(list(dirty[0], "uncommitted")).toContain("README.md");
    expect(list(dirty[0], "untracked")).toContain("notes.txt");
    // The commit that exists only here, counted against the upstream it has.
    expect(at(dirty[0], "ahead")).toBe(1);
    expect(at(dirty[0], "unreadable")).toBeNull();
    // Inside the workspaces directory, so the reset really does delete it.
    expect(at(dirty[0], "filesDeleted")).toBe(true);

    // And it is said in the plan's own words, above the general warning.
    const removes = list(planned, "plan.removes").join(" | ");
    expect(removes).toMatch(/1 uncommitted change/);
    expect(removes).toMatch(/1 untracked file/);
    expect(removes).toMatch(/1 unpushed commit/);
    expect(removes).toMatch(/not committed and pushed is destroyed/);
    expect(removes).toContain(checkout);

    // `everything` deletes the same checkouts, so it says the same thing.
    const all = await harness.ok("/reset/plan?scope=everything");
    expect(list(all, "plan.dirtyWorkspaces")).toHaveLength(1);

    // The arrangement scope deletes no checkout, so it claims nothing about one.
    const arrangement = await harness.ok("/reset/plan?scope=arrangement");
    expect(list(arrangement, "plan.dirtyWorkspaces")).toEqual([]);
    expect(list(arrangement, "plan.removes").join(" ")).not.toMatch(
      /destroyed/,
    );
  });

  it("names nothing when a checkout is clean, and still warns in general", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-clean-"));
    scratch.push(stateDir);
    seedProvisionedWorkspace(stateDir, join(stateDir, "workspaces", "tidy"));

    const harness = await boot({}, { stateDir });
    const planned = await harness.ok("/reset/plan?scope=derived");

    // Nothing is being lost from this one, and the plan does not invent a risk.
    expect(list(planned, "plan.dirtyWorkspaces")).toEqual([]);
    // The warning still stands, because the checkout is still deleted and the
    // operator may have work in one the product cannot see yet.
    expect(list(planned, "plan.removes").join(" ")).toMatch(
      /not committed and pushed is destroyed/,
    );
  });

  it("says it could not look, rather than that there is nothing there", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-unreadable-"));
    scratch.push(stateDir);
    const checkout = join(stateDir, "workspaces", "vanished");
    seedProvisionedWorkspace(stateDir, checkout);

    // The checkout is gone from under the record — the state a half-finished
    // manual cleanup leaves.
    rmSync(checkout, { recursive: true, force: true });

    const harness = await boot({}, { stateDir });
    const planned = await harness.ok("/reset/plan?scope=derived");

    const dirty = list(planned, "plan.dirtyWorkspaces");
    expect(dirty).toHaveLength(1);
    expect(at(dirty[0], "unreadable")).not.toBeNull();
    expect(list(planned, "plan.removes").join(" ")).toMatch(
      /could not be read .* check it before confirming/,
    );
  });
});
