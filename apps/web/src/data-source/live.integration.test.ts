/**
 * SYNC 2 GATE: canvas state = live server state.
 *
 * Spawns the real, built @plotroom/server (child process, ephemeral loopback
 * port, temp state dir), drives mutations through /api with the real
 * createApiActions, and asserts createApiGraphDataSource — over real fetch
 * and a real WebSocket — reflects them live: the initial snapshot is
 * correct, a subsequent mutation arrives over /ws and updates the snapshot
 * without a manual refetch, and an illegal wire surfaces as a refusal
 * (never a crash, never treated as success) rather than reaching the graph.
 *
 * `@plotroom/server` is a devDependency purely so turbo's `test` task
 * (`dependsOn: ["^build"]`) builds it before this runs, and so this file has
 * a compiled entry point to spawn — nothing here imports its source.
 *
 * `createHttpClient`/`createApiGraphDataSource` still enforce the
 * same-origin rule on every path they're given; the origin resolution a
 * browser does implicitly (relative to `location`) is done explicitly here
 * instead, in the `fetchImpl`/`createSocket` adapters below — this test has
 * no page origin to be relative to.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { MinimalWebSocket } from "@plotroom/ui";
import {
  createApiActions,
  createApiGraphDataSource,
  createHttpClient,
} from "@plotroom/ui";
import type { GraphSnapshot } from "@plotroom/ui";

const SERVER_ENTRY = fileURLToPath(
  new URL("../../../server/dist/index.js", import.meta.url),
);

let nextPort = 47_100;
function ephemeralPort(): number {
  nextPort += 1;
  return nextPort;
}

interface RunningServer {
  readonly port: number;
  readonly stateDir: string;
  stop(): Promise<void>;
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`server on port ${port} never became healthy`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startServer(): Promise<RunningServer> {
  const port = ephemeralPort();
  const stateDir = mkdtempSync(join(tmpdir(), "plotroom-web-gate-"));

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: "ignore",
    env: {
      ...process.env,
      PLOTROOM_PORT: String(port),
      PLOTROOM_STATE_DIR: stateDir,
      // A directory that cannot exist as a built renderer: the gate test
      // only cares about /api and /ws, and a missing renderer already
      // degrades to a reported 503 rather than breaking either (Epic 3.0).
      PLOTROOM_STATIC_DIR: join(stateDir, "no-such-renderer"),
      PLOTROOM_LOG_LEVEL: "error",
    },
  });

  await waitForHealth(port);

  return {
    port,
    stateDir,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

/** Same-origin resolution a browser does implicitly; explicit here (no page origin). */
function httpClientFor(port: number) {
  return createHttpClient((path, init) =>
    fetch(`http://127.0.0.1:${port}${path}`, init),
  );
}

function socketFactoryFor(port: number) {
  return (path: string): MinimalWebSocket =>
    new WebSocket(
      `ws://127.0.0.1:${port}${path}`,
    ) as unknown as MinimalWebSocket;
}

function waitForSnapshot(
  snapshots: readonly GraphSnapshot[],
  predicate: (snapshot: GraphSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<GraphSnapshot> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = snapshots.find(predicate);
      if (match) {
        resolve(match);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for a matching live snapshot"));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

const servers: RunningServer[] = [];
const unsubscribes: Array<() => void> = [];

afterEach(async () => {
  while (unsubscribes.length > 0) unsubscribes.pop()?.();
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.stop();
      rmSync(server.stateDir, { recursive: true, force: true });
    }
  }
});

describe("Sync 2 gate: canvas state = live server state", () => {
  it("reflects a workstream, a wired command, and refuses an illegal edge, all live", async () => {
    const server = await startServer();
    servers.push(server);

    const http = httpClientFor(server.port);
    const actions = createApiActions(http);
    const dataSource = createApiGraphDataSource({
      http,
      createSocket: socketFactoryFor(server.port),
    });

    const snapshots: GraphSnapshot[] = [];
    const unsubscribe = dataSource.subscribe((snapshot) => {
      snapshots.push(snapshot);
    });
    unsubscribes.push(unsubscribe);

    // Initial snapshot: a fresh server, nothing on the board yet.
    const initial = await waitForSnapshot(snapshots, () => true);
    expect(initial.nodes).toEqual([]);
    expect(initial.edges).toEqual([]);

    // Drive real mutations through /api.
    const note = await actions.createNote({
      title: "ticket-ish note",
      body: "context for the command",
    });
    expect(note.ok).toBe(true);
    if (!note.ok) return;

    const workstream = await actions.createWorkstream();
    expect(workstream.ok).toBe(true);
    if (!workstream.ok) return;

    const contentNode = await actions.placeNode({
      role: "content",
      refId: note.value.objectId,
      workstreamId: workstream.value.workstreamId,
    });
    expect(contentNode.ok).toBe(true);
    if (!contentNode.ok) return;

    // Live, via /ws — never a manual refetch: the content node shows up
    // in a later snapshot than the one `subscribe` first delivered.
    const afterContentNode = await waitForSnapshot(snapshots, (snapshot) =>
      snapshot.nodes.some((node) => node.id === contentNode.value.nodeId),
    );
    expect(
      afterContentNode.nodes.find(
        (node) => node.id === contentNode.value.nodeId,
      ),
    ).toMatchObject({ role: "content", label: "ticket-ish note" });

    const definition = await http.post<{ definition: { id: string } }>(
      "/api/command-definitions",
      {
        name: "test command",
        instruction: "do the thing",
        model: "test-model",
        effort: "low",
        lifecycle: "open",
      },
    );

    const command = await actions.instantiateCommand({
      definitionId: definition.definition.id,
      workstreamId: workstream.value.workstreamId,
    });
    expect(command.ok).toBe(true);
    if (!command.ok) return;

    await waitForSnapshot(snapshots, (snapshot) =>
      snapshot.nodes.some((node) => node.id === command.value.nodeId),
    );

    // A legal wire (content -> command): arrives live and is readable as
    // a context edge.
    const wired = await actions.addContextEdge({
      from: contentNode.value.nodeId,
      to: command.value.nodeId,
    });
    expect(wired.ok).toBe(true);
    if (!wired.ok) return;

    const afterWire = await waitForSnapshot(snapshots, (snapshot) =>
      snapshot.contextEdges.some(
        (edge) =>
          edge.from === contentNode.value.nodeId &&
          edge.to === command.value.nodeId,
      ),
    );
    expect(afterWire.edges.map((edge) => edge.id)).toContain(
      wired.value.edgeId,
    );

    // An illegal wire (content -> content): refused, not a crash and not
    // silently accepted — and it never reaches the live graph.
    const secondNote = await actions.createNote({
      title: "another note",
      body: "irrelevant",
    });
    expect(secondNote.ok).toBe(true);
    if (!secondNote.ok) return;
    const secondContentNode = await actions.placeNode({
      role: "content",
      refId: secondNote.value.objectId,
      workstreamId: workstream.value.workstreamId,
    });
    expect(secondContentNode.ok).toBe(true);
    if (!secondContentNode.ok) return;

    const refused = await actions.addContextEdge({
      from: contentNode.value.nodeId,
      to: secondContentNode.value.nodeId,
    });
    expect(refused).toEqual({
      ok: false,
      refusal: {
        reason: "illegal_target",
        message: expect.stringContaining("content cannot be wired"),
      },
    });

    // Give any (incorrect) event a moment to arrive, then confirm the
    // live edge count did not change because of the refused attempt.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const edgeCountAfterRefusal = snapshots.at(-1)?.edges.length;
    expect(edgeCountAfterRefusal).toBe(afterWire.edges.length);
  }, 30_000);
});
