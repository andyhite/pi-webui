import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { humanAuthor, INHERIT_APP_TOOLS } from "@plotroom/core";
import { openDatabase } from "@plotroom/db";
import { loadServerConfig } from "../config.js";
import { createEventBus } from "../events/bus.js";
import { startServer } from "../index.js";
import { createStores } from "../routes/api.js";

/**
 * The search backfill (§6.8, Epic 8.2): a session that ended before this
 * feature existed — and so was never reindexed at start/checkpoint/end —
 * becomes findable the first time this build boots over its state
 * directory, and stays findable (not duplicated) on every boot after.
 *
 * The "pre-existing" session here is built directly through `@plotroom/db`'s
 * stores, deliberately bypassing the run path that calls
 * `reindexSessionSearch` — exactly what a session from before this code
 * existed looks like: a row in `sessions`, nothing in `search`.
 */

const scratch: string[] = [];
const handles: ReturnType<typeof startServer>[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function boot(stateDir: string) {
  // Port 0, and the bound one comes back from the socket: probing for a free port
  // and binding it second leaves a window for something else to take it.
  const handle = startServer(
    loadServerConfig(
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
        pluginsInBox: [],
        runtime: { adapterId: "scripted" },
        workspace: { kind: "git", directory: join(stateDir, "workspaces") },
      },
    ),
  );
  handles.push(handle);
  // Before `recovered`, so a bind failure is this line's error rather than an
  // unhandled `error` event surfacing as whatever times out next.
  const { port } = await handle.listening;
  await handle.recovered;
  return { handle, port };
}

async function search(port: number, q: string): Promise<{ hits: unknown[] }> {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/search?q=${encodeURIComponent(q)}`,
    { headers: { origin: `http://localhost:${port}` } },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { hits: unknown[] };
}

describe("the search backfill (§6.8, Epic 8.2)", () => {
  it("makes a pre-existing ended session findable, and never duplicates it on a later boot", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-backfill-"));
    scratch.push(stateDir);

    let sessionId: string;
    {
      // A session that ended before search indexing existed: written
      // straight through the db stores, never through a run.
      const db = openDatabase({ stateDir });
      const bus = createEventBus();
      const stores = createStores(db, bus);

      const workstream = stores.workstreams.create({ author: humanAuthor });
      const subject = stores.objects.write({
        kind: "ticket",
        title: "PreexistingBackfillTarget",
        renderings: { card: {}, summary: "a ticket", agentContent: "content" },
        workstreamId: workstream.id,
      });
      stores.workstreams.setSubject(
        workstream.id,
        subject.objectId,
        humanAuthor,
      );

      const session = stores.sessions.start({
        workstreamId: workstream.id,
        mode: "open",
        launch: {
          model: "fixture-model",
          effort: "medium",
          toolPermissions: INHERIT_APP_TOOLS,
        },
        initiatedBy: humanAuthor,
        runtime: { adapterId: "scripted", ref: "native-1" },
      });
      stores.sessions.end(session.session.id, {
        kind: "ended-by-user",
        at: stores.clock(),
      });
      sessionId = session.session.id;

      // The premise: nothing has reindexed it yet.
      expect(stores.search.has("session", sessionId)).toBe(false);

      db.close();
    }

    const first = await boot(stateDir);
    const found = await search(first.port, "PreexistingBackfillTarget");
    expect(found.hits).toHaveLength(1);
    expect((found.hits[0] as { refId: string }).refId).toBe(sessionId);
    await first.handle.close();
    handles.pop();

    // A second boot over the same, now-backfilled state directory finds the
    // same one row rather than a second copy of it (idempotent, §6.8).
    const second = await boot(stateDir);
    const foundAgain = await search(second.port, "PreexistingBackfillTarget");
    expect(foundAgain.hits).toHaveLength(1);
  });
});
