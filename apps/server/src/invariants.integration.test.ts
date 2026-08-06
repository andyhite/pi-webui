import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, afterEach, describe, it } from "bun:test";
import {
  ConnectionRefused,
  GraphStore,
  Maintenance,
  ObjectStore,
  RunStore,
  openDatabase,
} from "@plotroom/db";
import {
  DEFAULT_COMPACTION_POLICY,
  sessionAuthor,
  type Author,
  type CommandId,
  type CompactionPolicy,
  type SessionId,
} from "@plotroom/core";
import type { RuntimeScript } from "./runtime/scripted.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  list,
  repository,
  run,
  str,
  waitFor,
  type Harness,
} from "./testing/harness.js";

/**
 * The §15 invariant regression suite (Epic 8.5, cross-cutting rule 1).
 *
 * Spec §15 names four things that are **schema-shaped rather than
 * feature-shaped**: "get them wrong at the start and every historical record is
 * permanently degraded". They are not features that can be re-added later, so
 * they get a suite of their own, named so a CI failure here reads as what it is —
 * an invariant breach, not a broken test.
 *
 * Asserted against the live store through the real API, because that is where
 * they can actually be violated: a unit test over a predicate cannot tell you
 * that the endpoint wrote the row.
 *
 *   1. Run history records the **full assembled content and configuration**.
 *   2. **Every context edge records its author** — schema and API both refuse.
 *   3. **Version retention with the compaction rule**: run-referenced and pinned
 *      versions are never compacted.
 *   4. **Per-run output addressing**: `output@n` for every n, `latest` derived.
 *
 * Plus the three rules whose failure mode is the same kind of permanent damage:
 * reflexivity (principle 1), never silently truncating (principle 12), and one
 * gesture creating one thing (principle 9).
 *
 * **Every test here asserts, rather than exercises.** The distinction is the
 * acceptance bar for this suite: each one is written so that *weakening* the
 * invariant makes it fail, not merely so that a happy path uses it. Three
 * techniques recur, and each is used because the weaker version of the same test
 * would pass against a broken product:
 *
 * - **The violating write is attempted, through every surface that can reach the
 *   row** — the API with a bad actor, the store bypassing the API, and raw SQL
 *   bypassing both. A test that only performs the *legal* write cannot tell you
 *   the illegal one is refused.
 * - **The record is compared byte for byte with what the product promised**,
 *   rather than merely being non-empty: a run that recorded a summary, a
 *   re-assembly, or today's configuration would satisfy "not null" and violate
 *   §15-1 completely.
 * - **The rule is pushed to its edge**: retention is run with the most
 *   aggressive policy expressible and a clock far past every window, so what
 *   survives, survives *because of the rule* rather than because nothing was old
 *   enough yet.
 *
 * The schema-census half of the same job — that the teeth are still on the
 * columns, in every table at once — lives in
 * `packages/db/src/invariants.schema.test.ts`, which needs no server.
 */
afterEach(cleanupHarnesses);

const oneTurn: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { observation: { kind: "output-delta", text: "working" } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 20, outputTokens: 5, costUsd: 0.001 },
          },
        },
      ],
    },
  ],
};

/**
 * A second connection to the same state directory, for the store-level reads,
 * the store-level *refusals*, and the raw SQL a store cannot be asked to write.
 *
 * `daysAhead` moves the stores' clock, not the server's: retention is a rule about
 * age, and a suite that could only test it by waiting could not test it at all.
 * The stores take an injectable clock for exactly this reason (AGENTS.md), so the
 * sweep runs against the *real* default policy rather than a policy invented to
 * make a test pass.
 */
function store(harness: Harness, daysAhead = 0) {
  const state = openDatabase({ stateDir: harness.stateDir });
  const clock = () => Math.floor(Date.now() / 1000) + daysAhead * 24 * 60 * 60;
  return {
    state,
    runs: new RunStore(state, clock),
    objects: new ObjectStore(state, clock),
    graph: new GraphStore(state, clock),
    maintenance: new Maintenance(state, clock),
    close: () => state.close(),
  };
}

/**
 * A harness whose scripted runtime has a script of its own, for the gestures
 * that start a session PlotRoom was not handed a script for: a fork's new
 * session is opened by the adapter, not by a run request (§6.3).
 */
async function bootScripted(script: RuntimeScript = oneTurn): Promise<Harness> {
  const path = join(
    mkdtempSync(join(tmpdir(), "plotroom-invariants-")),
    "script.json",
  );
  writeFileSync(path, JSON.stringify(script), "utf8");
  return boot({
    ...repository(),
    runtime: { adapterId: "scripted", scriptPath: path },
  });
}

/** Every column in the whole schema, as `table.column`. */
function allColumns(harness: Harness): string[] {
  const { state, close } = store(harness);
  try {
    return state.sqlite
      .prepare<[], { tbl: string; col: string }>(
        `SELECT m.name AS tbl, p.name AS col
           FROM sqlite_master m JOIN pragma_table_info(m.name) p
          WHERE m.type = 'table'`,
      )
      .all()
      .map((row) => `${row.tbl}.${row.col}`);
  } finally {
    close();
  }
}

/** The session node standing for a session id (§3.7, principle 5). */
async function sessionNodeId(
  harness: Harness,
  sessionId: string,
): Promise<string> {
  const node = list(await harness.ok("/snapshot"), "nodes").find(
    (candidate) =>
      at(candidate, "role") === "session" &&
      at(candidate, "refId") === sessionId,
  );
  return String(at(node, "id"));
}

/** A content node carrying a fresh note, placed by whoever asks for it. */
async function contentNode(
  harness: Harness,
  title: string,
  actor?: string,
): Promise<string> {
  const note = await harness.ok("/notes", {
    method: "POST",
    body: { title, body: `${title} body` },
    ...(actor === undefined ? {} : { actor }),
  });
  const node = await harness.ok("/nodes", {
    method: "POST",
    body: { role: "content", refId: str(note, "object.id") },
    ...(actor === undefined ? {} : { actor }),
  });
  return str(node, "node.id");
}

describe("§15-1: a run records the full assembled content and configuration", () => {
  it("keeps the exact bytes the agent was given, after its inputs change", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "The ticket", body: "as it was at run time" }],
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const runId = str(started, "run.id");

    const assembled = await harness.ok(`/runs/${runId}/assembled`);
    const bytes = String(at(assembled, "content"));
    expect(bytes).toContain("as it was at run time");

    // The world moves: the note is rewritten and its consumers drift (§3.2).
    await harness.ok(`/notes/${fixture.noteIds[0] as string}`, {
      method: "PATCH",
      body: { body: "rewritten afterwards" },
    });

    // The record does not. "A history that recorded less leaves every past run
    // uncomparable forever" — so this is the assertion the whole invariant is for.
    const again = await harness.ok(`/runs/${runId}/assembled`);
    expect(at(again, "content")).toBe(bytes);
    expect(at(again, "hash")).toBe(at(assembled, "hash"));
    expect(String(at(again, "content"))).not.toContain("rewritten afterwards");
  });

  it("records the configuration it ran under, not a pointer to today's", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "body" }],
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const runId = str(started, "run.id");

    // The definition changes after the run — a different model, which is exactly
    // the field run comparison (§4.4) exists to compare.
    await harness.ok(`/command-definitions/${fixture.definitionId}`, {
      method: "PATCH",
      body: { model: "some-other-model" },
    });

    const read = await harness.ok(`/runs/${runId}`);
    expect(at(read, "configuration.model.model")).toBe("fixture-model");
    // And the versions that went in are recorded beside it, not instead of it.
    expect(list(read, "inputs").length).toBeGreaterThan(0);
    expect(at(read, "inputs.0.versionId")).toBeTruthy();
    expect(at(read, "inputs.0.contentHash")).toBeTruthy();
  });

  it("records the preview's own bytes, byte for byte, hash and length included", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [
        { title: "First", body: "the first input, in order" },
        { title: "Second", body: "the second input, after it" },
      ],
    });

    // "The preview is the contract": what §4.1 showed is what §15-1 must record.
    // A run that re-assembled its own content — or recorded a digest of it, or
    // the inputs without the body — would pass a not-null check and fail here.
    const preview = await harness.ok(`/commands/${fixture.commandId}/preview`);
    const promised = String(at(preview, "preview.body"));
    expect(promised).toContain("the first input, in order");

    const started = await run(harness, fixture.commandId, oneTurn);
    const runId = str(started, "run.id");

    const assembled = await harness.ok(`/runs/${runId}/assembled`);
    expect(at(assembled, "content")).toBe(promised);
    expect(at(assembled, "hash")).toBe(
      createHash("sha256").update(promised).digest("hex"),
    );

    const read = await harness.ok(`/runs/${runId}`);
    expect(at(read, "run.assembledBytes")).toBe(
      Buffer.byteLength(promised, "utf8"),
    );
    expect(at(read, "run.assembledHash")).toBe(at(assembled, "hash"));
    // Recorded in assembly order, one row per previewed part (§3.5).
    expect(list(read, "inputs").map((input) => at(input, "ordinal"))).toEqual(
      list(preview, "preview.inputs").map((part) => at(part, "ordinal")),
    );
    expect(list(read, "inputs")).toHaveLength(2);
  });

  it("cannot exist without them — through the API, the store, or raw SQL", async () => {
    const harness = await boot(repository());
    // Nothing wired: the emptiest run the API can be asked for, and still a
    // complete record. "No inputs" is not licence to record no assembly.
    const fixture = await command(harness, { lifecycle: "open" });
    const started = await run(harness, fixture.commandId, oneTurn);
    const runId = str(started, "run.id");

    const { state, runs, close } = store(harness);
    try {
      const row = state.sqlite
        .prepare<
          [string],
          {
            assembled_blob_id: string | null;
            assembled_hash: string | null;
            config_json: string | null;
            command_id: string;
            definition_id: string;
          }
        >("SELECT * FROM runs WHERE id = ?")
        .get(runId);

      expect(row?.assembled_blob_id).toBeTruthy();
      expect(row?.assembled_hash).toBeTruthy();
      expect(row?.config_json).toBeTruthy();
      // The blob the row names really holds the bytes the row measures: a
      // dangling reference is a half-record, which is what §15-1 forbids.
      expect(runs.assembledContent(runId)).toBe(
        String(at(await harness.ok(`/runs/${runId}/assembled`), "content")),
      );

      // The store is the only writer, and it writes both halves in one
      // transaction — so the surface left to attempt the violating write on is
      // the table itself. Both columns refuse, on insert and on update alike:
      // a run cannot be *created* without its record, and an existing one
      // cannot be *stripped* of it either.
      expect(() =>
        state.sqlite
          .prepare(
            `INSERT INTO runs (id, command_id, definition_id, ordinal, status,
                               assembled_hash, assembled_bytes, config_json)
             VALUES ('run_no_content', ?, ?, 99, 'running', 'h', 1, '{}')`,
          )
          .run(row?.command_id as string, row?.definition_id as string),
      ).toThrow(/NOT NULL constraint failed: runs.assembled_blob_id/u);

      expect(() =>
        state.sqlite
          .prepare(
            `INSERT INTO runs (id, command_id, definition_id, ordinal, status,
                               assembled_blob_id, assembled_hash, assembled_bytes)
             VALUES ('run_no_config', ?, ?, 98, 'running', ?, 'h', 1)`,
          )
          .run(
            row?.command_id as string,
            row?.definition_id as string,
            row?.assembled_blob_id as string,
          ),
      ).toThrow(/NOT NULL constraint failed: runs.config_json/u);

      expect(() =>
        state.sqlite
          .prepare("UPDATE runs SET config_json = NULL WHERE id = ?")
          .run(runId),
      ).toThrow(/NOT NULL constraint failed: runs.config_json/u);

      expect(() =>
        state.sqlite
          .prepare("UPDATE runs SET assembled_blob_id = NULL WHERE id = ?")
          .run(runId),
      ).toThrow(/NOT NULL constraint failed: runs.assembled_blob_id/u);

      // And no run in the store — however it got there — is missing either half.
      const halves = state.sqlite
        .prepare<[], { broken: number }>(
          `SELECT COUNT(*) AS broken FROM runs
            WHERE assembled_blob_id IS NULL OR config_json IS NULL
               OR assembled_hash IS NULL OR assembled_bytes IS NULL`,
        )
        .get();
      expect(halves?.broken).toBe(0);
    } finally {
      close();
    }
  });
});

describe("§15-2: every context edge records its author", () => {
  it("cannot be represented without one — the schema refuses", async () => {
    const harness = await boot(repository());
    // A wired command, so there are real nodes for the illegal edges to name.
    await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "body" }],
    });

    const { state, close } = store(harness);
    try {
      const nodes = state.sqlite
        .prepare<[], { id: string }>("SELECT id FROM nodes LIMIT 2")
        .all();
      const from = nodes[0]?.id as string;
      const to = nodes[1]?.id as string;

      // `system` is reserved for provenance: a *context* edge nobody authored has
      // no representation, which is what makes the invariant an invariant rather
      // than a convention every writer must remember.
      expect(() =>
        state.sqlite
          .prepare(
            `INSERT INTO edges (id, kind, from_node, to_node, author_kind, ordinal, created_at)
             VALUES (?, 'context', ?, ?, 'system', 1, 1)`,
          )
          .run("edge_unattributed", from, to),
      ).toThrow(/CHECK constraint failed/u);

      // The nullable-column version of the same mistake, which is the one
      // retrofitting produces: "every pre-existing edge has an unknown author".
      expect(() =>
        state.sqlite
          .prepare(
            `INSERT INTO edges (id, kind, from_node, to_node, author_kind, ordinal, created_at)
             VALUES (?, 'context', ?, ?, NULL, 1, 1)`,
          )
          .run("edge_null_author", from, to),
      ).toThrow(/NOT NULL constraint failed: edges.author_kind/u);

      // A session author with no session named is the other way to say nobody.
      expect(() =>
        state.sqlite
          .prepare(
            `INSERT INTO edges (id, kind, from_node, to_node, author_kind, author_session, ordinal, created_at)
             VALUES (?, 'context', ?, ?, 'session', NULL, 1, 1)`,
          )
          .run("edge_anon_session", from, to),
      ).toThrow(/CHECK constraint failed/u);
    } finally {
      close();
    }
  });

  it("refuses an unattributed edge at the store, not only at the endpoint", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    const from = await contentNode(harness, "Unattributed");

    const { graph, close } = store(harness);
    try {
      // Bypassing the API entirely and reaching the store with the reserved
      // system author: the type forbids it, and a caller that casts past the
      // type still cannot write the row. Enforced twice on purpose (AGENTS.md).
      expect(() =>
        graph.addContextEdge({
          from,
          to: fixture.commandNodeId,
          author: { kind: "system" } as unknown as Author,
        }),
      ).toThrow(/CHECK constraint failed/u);

      // Nothing landed: a refused write leaves no half-attributed edge behind.
      expect(
        list(await harness.ok("/snapshot"), "edges").filter(
          (edge) => at(edge, "from") === from,
        ),
      ).toEqual([]);
    } finally {
      close();
    }
  });

  it("refuses an unparseable actor rather than defaulting to nobody", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "body" }],
    });

    const node = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: fixture.noteIds[0] as string,
        workstreamId: fixture.workstream,
      },
    });

    const wired = await harness.call("/edges", {
      method: "POST",
      body: { from: str(node, "node.id"), to: fixture.commandNodeId },
      actor: "nobody-in-particular",
    });

    // An omitted actor means the operator at the keyboard; an unparseable one is a
    // bad request. What is never allowed is an edge attributed to no one.
    expect(wired.status).toBe(400);

    // A session id naming no session is the same refusal, for the same reason:
    // "attributed to something that does not exist" is not attribution.
    const ghost = await harness.call("/edges", {
      method: "POST",
      body: { from: str(node, "node.id"), to: fixture.commandNodeId },
      actor: "session:sess_does_not_exist",
    });
    expect(ghost.status).toBeGreaterThanOrEqual(400);
  });

  it("attributes the edge to the session that wired it", async () => {
    const harness = await boot(repository());
    const holder = await command(harness, {
      lifecycle: "open",
      name: "Holder",
    });
    const sessionId = str(
      await run(harness, holder.commandId, oneTurn),
      "session.id",
    );

    // A peer command, outside the session's chain: collaboration is allowed, and
    // the edge records who decided it (principle 1's second half).
    const peer = await command(harness, { lifecycle: "open", name: "Peer" });
    const note = await harness.ok("/notes", {
      method: "POST",
      body: { title: "Finding", body: "worth knowing" },
    });
    const node = await harness.ok("/nodes", {
      method: "POST",
      body: { role: "content", refId: str(note, "object.id") },
      actor: `session:${sessionId}`,
    });

    const wired = await harness.ok("/edges", {
      method: "POST",
      body: { from: str(node, "node.id"), to: peer.commandNodeId },
      actor: `session:${sessionId}`,
    });

    expect(at(wired, "edge.author.kind")).toBe("session");
    expect(at(wired, "edge.author.sessionId")).toBe(sessionId);
  });

  it("reserves the system author for provenance, and records one for every run", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "body" }],
    });
    await run(harness, fixture.commandId, oneTurn);

    const { state, close } = store(harness);
    try {
      const rows = state.sqlite
        .prepare<
          [],
          { kind: string; author_kind: string; ordinal: number | null }
        >("SELECT kind, author_kind, ordinal FROM edges")
        .all();

      // Both kinds really exist here, or the two clauses below pass vacuously.
      expect(rows.some((row) => row.kind === "context")).toBe(true);
      expect(rows.some((row) => row.kind === "provenance")).toBe(true);

      for (const row of rows) {
        if (row.kind === "context") {
          // Authored, always: human or session, never system, never absent.
          expect(["human", "session"]).toContain(row.author_kind);
          expect(row.ordinal).not.toBeNull();
        } else {
          // Recorded as work happens, never authored (§3.7).
          expect(row.author_kind).toBe("system");
          expect(row.ordinal).toBeNull();
        }
      }

      // The other direction of "only for provenance": a provenance edge cannot
      // borrow a human author either, so the two vocabularies cannot blur.
      const nodes = state.sqlite
        .prepare<[], { id: string }>("SELECT id FROM nodes LIMIT 2")
        .all();
      expect(() =>
        state.sqlite
          .prepare(
            "INSERT INTO edges (id, kind, from_node, to_node, author_kind, relation, created_at) " +
              "VALUES ('edge_authored_provenance', 'provenance', ?, ?, 'human', 'session_delegated', 1)",
          )
          .run(nodes[0]?.id as string, nodes[1]?.id as string),
      ).toThrow(/CHECK constraint failed/u);
    } finally {
      close();
    }
  });
});

describe("§15-3: compaction never touches a run-referenced or pinned version", () => {
  it("retains what a run consumed, however old and however many versions later", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "the version the run consumed" }],
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const runId = str(started, "run.id");
    const consumed = str(
      await harness.ok(`/runs/${runId}`),
      "inputs.0.versionId",
    );

    // Several unreferenced intermediates on top of it.
    for (const body of ["one", "two", "three"]) {
      await harness.ok(`/notes/${fixture.noteIds[0] as string}`, {
        method: "PATCH",
        body: { body },
      });
    }

    // Forty days on, so the shipped thirty-day window has passed and nothing is
    // retained by age: only the rule itself can save a version now.
    const { objects, close } = store(harness, 40);
    try {
      const policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY;
      const swept = objects.compactVersions(policy);
      expect(swept.removed).toBeGreaterThan(0);

      const versions = objects.versions(fixture.noteIds[0] as string);
      const survivor = versions.find((version) => version.id === consumed);
      expect(survivor, "the version a run consumed must survive").toBeDefined();
      // It survived *because* the rule says so, not by luck of the window: the
      // retention metadata is what `isCompactable` reads (§15-3).
      expect(survivor?.runReferenced).toBe(true);

      // And the run can still be read whole, which is what §15-1 and §15-3
      // together are for.
      const record = await harness.ok(`/runs/${runId}/assembled`);
      expect(String(at(record, "content"))).toContain(
        "the version the run consumed",
      );
    } finally {
      close();
    }
  });

  it("retains everything a pinned run references — pinning is 'never compact this'", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "pinned run's input" }],
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const runId = str(started, "run.id");
    await harness.ok(`/runs/${runId}/pin`, { method: "POST", body: {} });

    for (const body of ["a", "b"]) {
      await harness.ok(`/notes/${fixture.noteIds[0] as string}`, {
        method: "PATCH",
        body: { body },
      });
    }

    const { runs, objects, close } = store(harness, 40);
    try {
      objects.compactVersions(DEFAULT_COMPACTION_POLICY);
      const reclaimed = runs.compactRuns({
        keepPerDefinition: 0,
        windowSeconds: 0,
      });
      // "Pinning is the human's word for never compact this" (§4.4): a policy that
      // keeps nothing by recency and nothing by age still keeps this one.
      expect(reclaimed.removed).toBe(0);

      const read = await harness.ok(`/runs/${runId}/assembled`);
      expect(String(at(read, "content"))).toContain("pinned run's input");
    } finally {
      close();
    }
  });

  it("sorts the three cases the rule names, in one real sweep", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "v1 — consumed by the run" }],
    });
    const noteId = fixture.noteIds[0] as string;

    const runId = str(await run(harness, fixture.commandId, oneTurn), "run.id");
    const consumed = str(
      await harness.ok(`/runs/${runId}`),
      "inputs.0.versionId",
    );

    // v2 and v3: unreferenced intermediates, the only case the rule compacts.
    for (const body of ["v2 — an intermediate", "v3 — another intermediate"]) {
      await harness.ok(`/notes/${noteId}`, { method: "PATCH", body: { body } });
    }
    // A pinned run over v3, so v3 is retained by the pin rather than by age…
    const pinnedRunId = str(
      await run(harness, fixture.commandId, oneTurn),
      "run.id",
    );
    await harness.ok(`/runs/${pinnedRunId}/pin`, { method: "POST", body: {} });
    // …and v4, the latest, which the rule never compacts whatever its age.
    await harness.ok(`/notes/${noteId}`, {
      method: "PATCH",
      body: { body: "v4 — the latest" },
    });

    const before = (await storeVersions(harness, noteId)).map(
      (version) => version.id,
    );
    expect(before).toHaveLength(4);
    const [v1, v2, v3, v4] = before as [string, string, string, string];
    expect(v1).toBe(consumed);

    // The sweep the operator can ask for right now removes nothing: everything
    // is inside the window, and a sweep that reclaimed a referenced version
    // while it was young would be the same breach a day earlier.
    const now = await harness.ok("/maintenance/compact", {
      method: "POST",
      body: {},
    });
    expect(at(now, "compaction.versionsRemoved")).toBe(0);

    // The same sweep — `Maintenance.compact`, the real one, at the real default
    // policies — with the clock a year on, so nothing survives by being young.
    const { maintenance, objects, close } = store(harness, 365);
    try {
      const swept = maintenance.compact();
      // Exactly one of the four is compactable, and the count is asserted rather
      // than the survivors alone: a sweep that removed three would leave the
      // three assertions below passing on a store it had already damaged.
      expect(swept.versionsRemoved).toBe(1);

      const remaining = objects.versions(noteId).map((version) => version.id);
      expect(remaining).toContain(v1 as never); // run-referenced
      expect(remaining).toContain(v3 as never); // pinned by the pinned run
      expect(remaining).toContain(v4 as never); // the latest is never an intermediate
      expect(remaining).not.toContain(v2); // unreferenced intermediate: gone
    } finally {
      close();
    }

    // Both runs still read whole afterwards, which is the point of retaining
    // anything at all (§15-1's interplay with §15-3).
    for (const id of [runId, pinnedRunId]) {
      expect(
        String(at(await harness.ok(`/runs/${id}/assembled`), "content")).length,
      ).toBeGreaterThan(0);
    }
  });

  it("refuses to delete a run-consumed version even by direct DELETE", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "consumed" }],
    });
    const runId = str(await run(harness, fixture.commandId, oneTurn), "run.id");
    const consumed = str(
      await harness.ok(`/runs/${runId}`),
      "inputs.0.versionId",
    );

    const { state, close } = store(harness);
    try {
      // The foreign key is the teeth of the interplay: compaction can never
      // quietly eat run history, and neither can anything else holding a
      // connection to the store.
      expect(() =>
        state.sqlite
          .prepare("DELETE FROM object_versions WHERE id = ?")
          .run(consumed),
      ).toThrow(/FOREIGN KEY constraint failed/u);

      // Nor can the object be dropped out from under it (the version cascades).
      expect(() =>
        state.sqlite
          .prepare("DELETE FROM objects WHERE id = ?")
          .run(fixture.noteIds[0] as string),
      ).toThrow(/FOREIGN KEY constraint failed/u);
    } finally {
      close();
    }
  });
});

/** The versions of one object, oldest first — the order retention reasons in. */
async function storeVersions(
  harness: Harness,
  objectId: string,
): Promise<readonly { readonly id: string; readonly ordinal: number }[]> {
  const { objects, close } = store(harness);
  try {
    return objects
      .versions(objectId)
      .map((version) => ({ id: version.id, ordinal: version.ordinal }))
      .sort((a, b) => a.ordinal - b.ordinal);
  } finally {
    close();
  }
}

describe("§15-4: output@n is the general address and latest is derived", () => {
  it("resolves every n, and latest resolves to the newest of them", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness);

    const produced: {
      readonly objectId: string;
      readonly versionId: string;
    }[] = [];

    for (const attempt of ["first", "second", "third"]) {
      const started = await run(harness, fixture.commandId, oneTurn);
      const sessionId = str(started, "session.id");

      const object = await harness.ok("/objects", {
        method: "POST",
        body: {
          kind: "document",
          title: `result (${attempt})`,
          renderings: {
            card: { text: attempt },
            summary: attempt,
            agentContent: attempt,
          },
        },
      });
      const objectId = str(object, "object.id");
      const versionId = str(
        await harness.ok(`/objects/${objectId}/versions`),
        "versions.0.id",
      );

      // A submission with no declared conditions is proven trivially, which is
      // what records the output against the run (§3.5).
      const submitted = await harness.ok(`/sessions/${sessionId}/submit`, {
        method: "POST",
        body: { outputs: [{ name: "result", objectId, versionId }] },
      });
      expect(at(submitted, "accepted")).toBe(true);
      produced.push({ objectId, versionId });
    }

    const { runs, close } = store(harness);
    try {
      const commandId = fixture.commandId as CommandId;

      // Every n answers, and answers with what that run produced — not with the
      // newest. A system built on "the output" could not do this later.
      for (const [index, expected] of produced.entries()) {
        const resolved = runs.resolve({
          commandId,
          name: "result",
          at: "ordinal",
          runOrdinal: index + 1,
        });
        expect(resolved?.objectId, `output@${index + 1}`).toBe(
          expected.objectId as never,
        );
      }

      // `latest` is one query over the same ordering, stored nowhere — and it
      // agrees with the largest ordinal the history reports rather than with
      // whatever a column last remembered.
      const history = list(
        await harness.ok(`/commands/${fixture.commandId}/runs`),
        "runs",
      );
      const newest = Math.max(
        ...history.map((row) => Number(at(row, "ordinal"))),
      );
      expect(newest).toBe(3);
      const latest = runs.resolve({ commandId, name: "result", at: "latest" });
      expect(latest?.objectId as unknown).toBe(produced.at(-1)?.objectId);
      expect(
        history.find((row) => at(row, "id") === latest?.runId),
      ).toBeDefined();
      expect(
        Number(
          at(
            history.find((row) => at(row, "id") === latest?.runId),
            "ordinal",
          ),
        ),
      ).toBe(newest);
    } finally {
      close();
    }

    // There is no `latest` column *anywhere* in the schema: the one column whose
    // name mentions it is an object's newest-version pointer (§3.2), which is not
    // an output address. Pinned as a census, because the failure mode of §15-4 is
    // a well-meant denormalization on some other table entirely.
    expect(
      allColumns(harness).filter((column) => column.includes("latest")),
    ).toEqual(["objects.latest_version_id"]);
  });

  it("keeps the run an address resolves to, under the most aggressive retention there is", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness);

    // Two runs, only the first of which produces `result`: so `latest` for that
    // name resolves to an *old* run, which is the sharp edge of the rule —
    // "retention never makes a live address stop answering" (§4.4).
    const started = await run(harness, fixture.commandId, oneTurn);
    const first = str(started, "run.id");

    const produced = await harness.ok("/objects", {
      method: "POST",
      body: {
        kind: "document",
        title: "the addressed result",
        renderings: {
          card: { text: "addressed" },
          summary: "addressed",
          agentContent: "addressed",
        },
      },
    });
    const objectId = str(produced, "object.id");
    const versionId = str(
      await harness.ok(`/objects/${objectId}/versions`),
      "versions.0.id",
    );
    await harness.ok(`/sessions/${str(started, "session.id")}/submit`, {
      method: "POST",
      body: { outputs: [{ name: "result", objectId, versionId }] },
    });

    // A later run that produces nothing of that name.
    await run(harness, fixture.commandId, oneTurn);

    const { runs, close } = store(harness, 365);
    try {
      const commandId = fixture.commandId as CommandId;
      const before = runs.resolve({ commandId, name: "result", at: "latest" });
      expect(before?.runId as unknown).toBe(first);

      // Keep nothing by recency, nothing by age: the only thing left that can
      // save this run is the rule that an address must keep answering.
      const { removed } = runs.compactRuns({
        keepPerDefinition: 0,
        windowSeconds: 0,
      });

      // The sweep really swept — the later run went — so what survives below
      // survives by the rule and not because nothing was compactable.
      expect(removed).toBe(1);
      const surviving = runs.history(fixture.commandId).map((row) => row.id);
      expect(surviving as unknown).toEqual([first]);

      expect(runs.resolve({ commandId, name: "result", at: "latest" })).toEqual(
        before,
      );
      expect(
        runs.resolve({
          commandId,
          name: "result",
          at: "ordinal",
          runOrdinal: 1,
        }),
      ).toEqual(before);
    } finally {
      close();
    }
  });
});

describe("principle 1: no session authors intent into its own chain", () => {
  it("refuses the edge, with the predicate's own reason", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    const sessionId = str(
      await run(harness, fixture.commandId, oneTurn),
      "session.id",
    );

    const note = await harness.ok("/notes", {
      method: "POST",
      body: { title: "Self-serving", body: "wire me into myself" },
      actor: `session:${sessionId}`,
    });
    const node = await harness.ok("/nodes", {
      method: "POST",
      body: { role: "content", refId: str(note, "object.id") },
      actor: `session:${sessionId}`,
    });

    // Its own session node: authoring into itself, which no amount of routing
    // around can be allowed to reach.
    const sessionNode = await sessionNodeId(harness, sessionId);

    const refused = await harness.call("/edges", {
      method: "POST",
      body: { from: str(node, "node.id"), to: sessionNode },
      actor: `session:${sessionId}`,
    });

    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("own_chain");

    // And at the store, bypassing the endpoint: the predicate is what refuses,
    // so a second caller cannot disagree with the first (principle 8).
    const { graph, close } = store(harness);
    try {
      expect(() =>
        graph.addContextEdge({
          from: str(node, "node.id"),
          to: sessionNode,
          author: sessionAuthor(sessionId as SessionId),
        }),
      ).toThrow(ConnectionRefused);
      // No *context* edge reaches that session node. The provenance edge the run
      // recorded does, and must — it is the command that started it (§3.7).
      expect(
        list(await harness.ok("/snapshot"), "edges").some(
          (edge) =>
            at(edge, "to") === sessionNode && at(edge, "kind") === "context",
        ),
      ).toBe(false);
    } finally {
      close();
    }
  });

  it("refuses transitively — a grandchild cannot author into its grandparent", async () => {
    const harness = await boot(repository());

    // A human gesture, then two delegations: the chain every running session's
    // lineage terminates at a human through (principle 2).
    const first = await command(harness, { lifecycle: "open", name: "Root" });
    const root = str(
      await run(harness, first.commandId, oneTurn),
      "session.id",
    );

    const second = await command(harness, { lifecycle: "open", name: "Child" });
    const child = str(
      await run(harness, second.commandId, oneTurn, {
        actor: `session:${root}`,
      }),
      "session.id",
    );

    const third = await command(harness, {
      lifecycle: "open",
      name: "Grandchild",
    });
    const grandchild = str(
      await run(harness, third.commandId, oneTurn, {
        actor: `session:${child}`,
      }),
      "session.id",
    );

    const from = await contentNode(
      harness,
      "Upstream reading",
      `session:${grandchild}`,
    );

    // Its parent, its grandparent, and itself: "itself, its ancestors, or its
    // descendants" is one rule, and one hop is not the extent of it. A lineage
    // walk that stopped at the parent would pass the first case and fail here.
    for (const [what, target] of [
      ["itself", grandchild],
      ["its parent", child],
      ["its grandparent", root],
    ] as const) {
      const refused = await harness.call("/edges", {
        method: "POST",
        body: { from, to: await sessionNodeId(harness, target) },
        actor: `session:${grandchild}`,
      });
      expect(refused.status, what).toBe(409);
      expect(at(refused.body, "error.details.reason"), what).toBe("own_chain");
    }

    // Downwards too: the root authoring into its own descendant is the same
    // reflexivity from the other end.
    const rootContent = await contentNode(
      harness,
      "Root's own note",
      `session:${root}`,
    );
    const downwards = await harness.call("/edges", {
      method: "POST",
      body: { from: rootContent, to: await sessionNodeId(harness, grandchild) },
      actor: `session:${root}`,
    });
    expect(downwards.status).toBe(409);
    expect(at(downwards.body, "error.details.reason")).toBe("own_chain");

    // Nothing was wired by any of that: a refusal that logged and wrote would be
    // worse than one that threw.
    const { state, close } = store(harness);
    try {
      const authored = state.sqlite
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM edges WHERE kind = 'context' AND author_session = ?",
        )
        .get(grandchild);
      expect(authored?.n).toBe(0);
    } finally {
      close();
    }
  });

  it("lets a session outside the chain wire context in — that is collaboration", async () => {
    const harness = await boot(repository());
    const mine = await command(harness, { lifecycle: "open", name: "Mine" });
    const peerCommand = await command(harness, {
      lifecycle: "open",
      name: "Peer",
    });

    const mineSession = str(
      await run(harness, mine.commandId, oneTurn),
      "session.id",
    );
    const peer = str(
      await run(harness, peerCommand.commandId, oneTurn),
      "session.id",
    );

    const from = await contentNode(harness, "A finding", `session:${peer}`);
    const wired = await harness.call("/edges", {
      method: "POST",
      body: { from, to: await sessionNodeId(harness, mineSession) },
      actor: `session:${peer}`,
    });

    // Two human gestures, two chains: the rule bounds a session's reach into its
    // own lineage and nothing else. A test that only asserted refusals would pass
    // against a product that refused everything.
    expect(wired.status).toBe(201);
    expect(at(wired.body, "edge.author.sessionId")).toBe(peer);
  });
});

describe("principle 12: never silently truncate", () => {
  it("refuses a run over the declared hard cap instead of trimming it", async () => {
    const harness = await boot(repository());
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );

    const definition = await harness.ok("/command-definitions", {
      method: "POST",
      body: {
        name: "Tiny window",
        instruction: "Do it.",
        model: "fixture-model",
        effort: "medium",
        lifecycle: "open",
        // A cap small enough that the note below cannot fit under it.
        budget: {
          modelWindowTokens: 40,
          warnAtFraction: 0.5,
          hardCapTokens: 20,
        },
      },
    });
    const instantiated = await harness.ok("/commands", {
      method: "POST",
      body: {
        definitionId: str(definition, "definition.id"),
        workstreamId: workstream,
      },
    });

    const note = await harness.ok("/notes", {
      method: "POST",
      body: {
        title: "Long",
        body: "word ".repeat(500),
        workstreamId: workstream,
      },
    });
    const node = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: str(note, "object.id"),
        workstreamId: workstream,
      },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: { from: str(node, "node.id"), to: str(instantiated, "node.id") },
    });

    // The preview says so before anything is spent, in words rather than by
    // omitting content.
    const preview = await harness.ok(
      `/commands/${str(instantiated, "command.id")}/preview`,
    );
    expect(at(preview, "preview.runnable")).toBe(false);
    expect(
      list(preview, "preview.blockers").map((blocker) => at(blocker, "reason")),
    ).toContain("content_budget");

    const refused = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: str(instantiated, "command.id"),
        initiationKey: "over-cap",
        runtime: { script: oneTurn },
      },
    });

    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("content_budget");

    // Nothing ran, and nothing was quietly shortened to make it fit.
    expect(
      list(
        await harness.ok(`/commands/${str(instantiated, "command.id")}/runs`),
        "runs",
      ),
    ).toHaveLength(0);
  });

  it("warns as it approaches the window and carries every byte anyway", async () => {
    const harness = await boot(repository());
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );

    // No hard cap: the product's default posture is to warn, never to trim.
    const definition = await harness.ok("/command-definitions", {
      method: "POST",
      body: {
        name: "Close to the window",
        instruction: "Do it.",
        model: "fixture-model",
        effort: "medium",
        lifecycle: "open",
        budget: {
          modelWindowTokens: 200,
          warnAtFraction: 0.5,
          hardCapTokens: null,
        },
      },
    });
    const instantiated = await harness.ok("/commands", {
      method: "POST",
      body: {
        definitionId: str(definition, "definition.id"),
        workstreamId: workstream,
      },
    });

    const body = `FIRST-WORD ${"filler ".repeat(400)}LAST-WORD`;
    const note = await harness.ok("/notes", {
      method: "POST",
      body: { title: "Long", body, workstreamId: workstream },
    });
    const node = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: str(note, "object.id"),
        workstreamId: workstream,
      },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: { from: str(node, "node.id"), to: str(instantiated, "node.id") },
    });

    const commandId = str(instantiated, "command.id");
    const preview = await harness.ok(`/commands/${commandId}/preview`);
    expect(at(preview, "preview.budget.state")).toBe("warn");
    expect(String(at(preview, "preview.budget.message"))).toContain("window");
    // Warned, not blocked: the operator decides, and the content is intact.
    expect(at(preview, "preview.runnable")).toBe(true);

    const started = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId,
        initiationKey: "near-the-window",
        runtime: { script: oneTurn },
      },
    });
    expect(started.status).toBe(201);
    // The warning travels with the run that carries it, rather than being a
    // console line nobody sees.
    expect(String(at(started.body, "warning"))).toContain("window");

    const runId = str(started.body, "run.id");
    const assembled = String(
      at(await harness.ok(`/runs/${runId}/assembled`), "content"),
    );
    // Both ends of the note reached the agent, and the recorded length is the
    // whole length: "a truncated context is a wrong answer with no evidence".
    expect(assembled).toContain("FIRST-WORD");
    expect(assembled).toContain("LAST-WORD");
    expect(assembled).toBe(String(at(preview, "preview.body")));
    expect(at(await harness.ok(`/runs/${runId}`), "run.assembledBytes")).toBe(
      Buffer.byteLength(assembled, "utf8"),
    );
  });

  it("states the bound on every read of a bounded surface", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    await run(harness, fixture.commandId, oneTurn);

    // The structured log is a ring buffer, so it *does* drop — and says so on
    // every read rather than leaving a silent gap in `seq` (§8).
    const logs = await harness.ok("/logs?limit=5");
    expect(typeof at(logs, "droppedTotal")).toBe("number");
    expect(Number(at(logs, "capacity"))).toBeGreaterThan(0);
    // A number when there is something to bound, and `null` — never a
    // fabricated 0 — when the buffer is empty (principle 7).
    for (const bound of ["oldestSeq", "newestSeq"] as const) {
      const value = at(logs, bound);
      expect(value === null || typeof value === "number", bound).toBe(true);
    }
    expect(list(logs, "entries").length).toBeLessThanOrEqual(5);

    // A limit past the clamp is bounded rather than honoured — and the bound is
    // in the answer, so a client can tell a full page from the whole truth.
    const wide = await harness.ok("/logs?limit=99999");
    expect(list(wide, "entries").length).toBeLessThanOrEqual(
      Number(at(wide, "capacity")),
    );

    // An unparseable bound falls back to the default rather than to zero: a
    // surface that answered "nothing" because it could not read `limit` would be
    // silently dropping everything (§6.8's search is the same shape).
    const nonsense = await harness.ok("/search?q=session&limit=not-a-number");
    expect(at(nonsense, "query")).toBe("session");
    expect(Array.isArray(at(nonsense, "hits"))).toBe(true);
  });
});

describe("principle 9: one gesture creates one thing", () => {
  it("replays the same run and session for a repeated initiation key", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });

    const key = "one-gesture-one-run";
    const first = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: key,
        runtime: { script: oneTurn },
      },
    });
    expect(first.status).toBe(201);
    expect(at(first.body, "replayed")).toBe(false);

    const again = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: key,
        runtime: { script: oneTurn },
      },
    });

    // A retry, a reconnect, or a double-click: 200 and the same two ids, never a
    // second run and never a second session.
    expect(again.status).toBe(200);
    expect(at(again.body, "replayed")).toBe(true);
    expect(at(again.body, "run.id")).toBe(at(first.body, "run.id"));
    expect(at(again.body, "session.id")).toBe(at(first.body, "session.id"));

    expect(
      list(await harness.ok(`/commands/${fixture.commandId}/runs`), "runs"),
    ).toHaveLength(1);

    const { state, close } = store(harness);
    try {
      const sessions = state.sqlite
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sessions")
        .get();
      expect(sessions?.n).toBe(1);
    } finally {
      close();
    }
  });

  it("refuses a key already spent on a different gesture", async () => {
    const harness = await boot(repository());
    const one = await command(harness, { lifecycle: "open", name: "One" });
    const other = await command(harness, { lifecycle: "open", name: "Other" });

    const key = "shared-key";
    await harness.ok("/runs", {
      method: "POST",
      body: {
        commandId: one.commandId,
        initiationKey: key,
        runtime: { script: oneTurn },
      },
    });

    // Same key, different command: answering this as a retry would hand the
    // second gesture the first one's run.
    const reused = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: other.commandId,
        initiationKey: key,
        runtime: { script: oneTurn },
      },
    });
    expect(reused.status).toBe(409);
    expect(at(reused.body, "error.details.reason")).toBe(
      "initiation_key_reused",
    );

    // And no run of the other command exists, refused rather than half-made.
    expect(
      list(await harness.ok(`/commands/${other.commandId}/runs`), "runs"),
    ).toHaveLength(0);
  });

  it("frees the key a refused attempt spent", async () => {
    const harness = await boot(repository());
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const overCap = await harness.ok("/command-definitions", {
      method: "POST",
      body: {
        name: "Over cap",
        instruction: "Do it.",
        model: "fixture-model",
        effort: "medium",
        lifecycle: "open",
        budget: {
          modelWindowTokens: 40,
          warnAtFraction: 0.5,
          hardCapTokens: 1,
        },
      },
    });
    const capped = await harness.ok("/commands", {
      method: "POST",
      body: {
        definitionId: str(overCap, "definition.id"),
        workstreamId: workstream,
      },
    });
    const note = await harness.ok("/notes", {
      method: "POST",
      body: {
        title: "Long",
        body: "word ".repeat(200),
        workstreamId: workstream,
      },
    });
    const node = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: str(note, "object.id"),
        workstreamId: workstream,
      },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: { from: str(node, "node.id"), to: str(capped, "node.id") },
    });

    const key = "refused-then-reused";
    const refused = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: str(capped, "command.id"),
        initiationKey: key,
        runtime: { script: oneTurn },
      },
    });
    expect(refused.status).toBe(409);

    // The gesture produced nothing, so the key is free again: holding it would
    // turn one refused attempt into a permanently unusable key.
    const runnable = await command(harness, {
      lifecycle: "open",
      name: "Fine",
    });
    const second = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: runnable.commandId,
        initiationKey: key,
        runtime: { script: oneTurn },
      },
    });
    expect(second.status).toBe(201);
    expect(at(second.body, "replayed")).toBe(false);
  });

  it("replays a steering gesture too — one fork for one key", async () => {
    // A fork starts a session of its own, so this harness needs the runtime's
    // default script rather than one supplied per run.
    const harness = await bootScripted();
    const fixture = await command(harness, { lifecycle: "open" });
    const sessionId = str(
      await run(harness, fixture.commandId, oneTurn),
      "session.id",
    );
    await waitFor(async () => {
      const transcript = await harness.ok(`/sessions/${sessionId}/transcript`);
      return list(transcript, "turns").length >= 1 ? transcript : null;
    }, "the first turn to be recorded");

    const key = "one-gesture-one-fork";
    const first = await harness.call(`/sessions/${sessionId}/fork`, {
      method: "POST",
      body: { turn: 1, initiationKey: key },
    });
    expect(first.status).toBe(201);

    const again = await harness.call(`/sessions/${sessionId}/fork`, {
      method: "POST",
      body: { turn: 1, initiationKey: key },
    });

    // A fork spends a key and produces no run at all (§6.3), so this is the case
    // a run-shaped idempotency would get wrong: replayed, not refused, and the
    // same session rather than a second fork.
    expect(again.status).toBe(200);
    expect(at(again.body, "replayed")).toBe(true);
    expect(at(again.body, "session.id")).toBe(at(first.body, "session.id"));

    const forkEdges = list(await harness.ok("/snapshot"), "edges").filter(
      (edge) => at(edge, "relation") === "session_forked_from",
    );
    expect(forkEdges).toHaveLength(1);
  });
});
