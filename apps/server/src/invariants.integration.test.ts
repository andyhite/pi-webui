import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, ObjectStore, RunStore } from "@plotroom/db";
import {
  DEFAULT_COMPACTION_POLICY,
  type CommandId,
  type CompactionPolicy,
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
  type Harness,
} from "./testing/harness.js";

/**
 * The §15 invariant regression suite.
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
 * Plus the two rules whose failure mode is the same kind of permanent damage:
 * reflexivity (principle 1) and never silently truncating (principle 12).
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
 * A second connection to the same state directory, for the store-level reads.
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
    close: () => state.close(),
  };
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
});

describe("§15-2: every context edge records its author", () => {
  it("cannot be represented without one — the schema refuses", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
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
      const insert =
        "INSERT INTO edges (id, kind, from_node, to_node, author_kind, ordinal, created_at) " +
        "VALUES (?, 'context', ?, ?, 'system', 1, 1)";

      expect(() =>
        state.sqlite
          .prepare(insert)
          .run(`edge_unattributed_${fixture.commandId}`, from, to),
      ).toThrow(/CHECK constraint failed/u);
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
});

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
          expected.objectId,
        );
      }

      // `latest` is one query over the same ordering, stored nowhere.
      const latest = runs.resolve({ commandId, name: "result", at: "latest" });
      expect(latest?.objectId).toBe(produced.at(-1)?.objectId);

      // There is no `latest` column anywhere: the schema cannot even express one.
      const columns = store(harness)
        .state.sqlite.prepare<[], { name: string }>(
          "SELECT name FROM pragma_table_info('run_outputs')",
        )
        .all()
        .map((column) => column.name);
      expect(columns).not.toContain("latest");
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
    const sessionNode = list(await harness.ok("/snapshot"), "nodes").find(
      (candidate) =>
        at(candidate, "role") === "session" &&
        at(candidate, "refId") === sessionId,
    );

    const refused = await harness.call("/edges", {
      method: "POST",
      body: {
        from: str(node, "node.id"),
        to: String(at(sessionNode, "id")),
      },
      actor: `session:${sessionId}`,
    });

    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("own_chain");
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
});
