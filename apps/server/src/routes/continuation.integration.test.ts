import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, WorkspaceStore } from "@plotroom/db";
import type { RuntimeScript } from "../runtime/scripted.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  endedSession,
  list,
  repository,
  run,
  str,
  waitFor,
  type Harness,
} from "../testing/harness.js";

/**
 * Resume, fork, and handoff, over the real app (§6.3, §4.3).
 *
 * The §6.3 choice is explicit in the API's own shape — two endpoints and no third,
 * neither reachable by typing — and these prove the gates behind them: that a
 * diverged workspace really refuses a resume, that a fork really gets its own
 * workstream and workspace with the mode that actually ran, that an unreviewed
 * brief really cannot be sent, and that continue-versus-fresh really describes the
 * option it refuses.
 */
afterEach(cleanupHarnesses);

const twoTurns: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { observation: { kind: "output-delta", text: "first thoughts" } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 10, outputTokens: 4 },
          },
        },
        { observation: { kind: "turn-started", turn: 2 } },
        { observation: { kind: "output-delta", text: "second thoughts" } },
        {
          observation: {
            kind: "turn-ended",
            turn: 2,
            usage: { inputTokens: 6, outputTokens: 3 },
          },
        },
      ],
    },
    {
      on: "injection",
      steps: [
        { observation: { kind: "turn-started", turn: 3 } },
        { observation: { kind: "output-delta", text: "picking it back up" } },
        {
          observation: {
            kind: "turn-ended",
            turn: 3,
            usage: { inputTokens: 4, outputTokens: 2 },
          },
        },
      ],
    },
  ],
};

async function bootWith(script: RuntimeScript): Promise<Harness> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const dir = mkdtempSync(join(tmpdir(), "plotroom-cont-"));
  const path = join(dir, "script.json");
  writeFileSync(path, JSON.stringify(script), "utf8");

  return boot({
    ...repository(),
    runtime: { adapterId: "scripted", scriptPath: path },
  });
}

/** A session that has run two turns and ended, ready to resume or fork. */
async function endedTwoTurnSession(harness: Harness): Promise<{
  readonly sessionId: string;
  readonly workstream: string;
  readonly commandId: string;
}> {
  const fixture = await command(harness, { lifecycle: "open" });
  const started = await run(harness, fixture.commandId, twoTurns);
  const sessionId = str(started, "session.id");

  await waitFor(async () => {
    const transcript = await harness.ok(`/sessions/${sessionId}/transcript`);
    return list(transcript, "turns").length >= 2 ? transcript : null;
  }, "both turns to be recorded");

  await harness.ok(`/sessions/${sessionId}/stop`, { method: "POST", body: {} });
  await endedSession(harness, sessionId);

  return {
    sessionId,
    workstream: fixture.workstream,
    commandId: fixture.commandId,
  };
}

/** Fingerprint the workspace, then move the branch under it — a real divergence. */
function divergeWorkspace(harness: Harness, workstreamId: string): void {
  const state = openDatabase({ stateDir: harness.stateDir });
  try {
    const workspaces = new WorkspaceStore(state);
    const workspace = workspaces.forWorkstream(workstreamId);
    if (workspace === null) throw new Error("no workspace to diverge");

    const path = workspace.roots[0]?.path;
    if (path === undefined) throw new Error("the workspace has no root");

    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: path,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      })
        .toString()
        .trim();

    // The fingerprint the session's picture is compared against.
    workspaces.setFingerprint(workspace.id, {
      kind: workspace.kind,
      observedAt: Date.now(),
      units: [
        {
          rootKey: workspace.roots[0]?.key ?? "root",
          head: git("rev-parse", "HEAD"),
          branch: git("rev-parse", "--abbrev-ref", "HEAD"),
          upstream: null,
          upstreamHead: null,
          // A digest over the uncommitted set, so a hand edit is detectable
          // without storing what it was (§3.4).
          dirtyDigest: "clean",
          dirtyCount: 0,
        },
      ],
    });

    // Then somebody else commits in it — a terminal, another tool, the operator.
    writeFileSync(join(path, "moved.txt"), "changed outside the session\n");
    git("add", ".");
    git(
      "-c",
      "user.email=t@t.invalid",
      "-c",
      "user.name=T",
      "commit",
      "-m",
      "outside the session",
    );
  } finally {
    state.close();
  }
}

describe("resume (§6.3, §4.3)", () => {
  it("continues the same record, and delivers the first turn as an injection", async () => {
    const harness = await bootWith(twoTurns);
    const { sessionId } = await endedTwoTurnSession(harness);

    const resumed = await harness.ok(`/sessions/${sessionId}/resume`, {
      method: "POST",
      body: {
        firstTurn: "carry on from where you left off",
        initiationKey: "resume-1",
      },
    });

    // The same session id: resuming continues the record, which is the whole
    // difference from forking.
    expect(at(resumed, "session.id")).toBe(sessionId);
    // And it is live again — a record that kept its end would report a running
    // session as finished (§3.6).
    expect(at(resumed, "session.end")).toBeNull();
    expect(at(resumed, "firstTurnQueued")).toBe(true);

    // The opening turn is an ordinary injection: on the graph, attributed (§6.5).
    const ledger = list(
      await harness.ok(`/sessions/${sessionId}/injections`),
      "injections",
    );
    expect(ledger).toHaveLength(1);
    expect(at(ledger[0], "author.kind")).toBe("human");

    // One gesture, one resumption (principle 9).
    const again = await harness.call(`/sessions/${sessionId}/resume`, {
      method: "POST",
      body: { initiationKey: "resume-1" },
    });
    expect(again.status).toBe(200);
    expect(at(again.body, "replayed")).toBe(true);
  });

  it("refuses resuming a session that never stopped", async () => {
    const harness = await bootWith(twoTurns);
    const fixture = await command(harness, { lifecycle: "open" });
    const sessionId = str(
      await run(harness, fixture.commandId, twoTurns),
      "session.id",
    );

    const refused = await harness.call(`/sessions/${sessionId}/resume`, {
      method: "POST",
      body: { initiationKey: "resume-live" },
    });

    // "This is injection, not resumption" (§6.5): the session is still running.
    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("already_running");
  });

  it("refuses when the workspace diverged — forced fresh (§4.3)", async () => {
    const harness = await bootWith(twoTurns);
    const { sessionId, workstream } = await endedTwoTurnSession(harness);

    divergeWorkspace(harness, workstream);

    const refused = await harness.call(`/sessions/${sessionId}/resume`, {
      method: "POST",
      body: { initiationKey: "resume-diverged" },
    });

    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("workspace_diverged");
    // The gate's own words, so the operator is told what to do instead: "start
    // fresh, or fork from a point before the change".
    expect(String(at(refused.body, "error.message"))).toContain("fork");
  });
});

describe("fork (§6.3)", () => {
  it("previews the point, then forks into its own workstream and workspace", async () => {
    const harness = await bootWith(twoTurns);
    const { sessionId, workstream } = await endedTwoTurnSession(harness);

    const preview = await harness.ok(
      `/sessions/${sessionId}/fork-preview?turn=1`,
    );
    expect(at(preview, "point.turn")).toBe(1);
    // The scripted runtime has no native fork, so the plan says seeded — and never
    // pretends otherwise, because the two are not bit-identical.
    expect(at(preview, "runtime.mode")).toBe("seeded");
    // Cleanliness is three-valued: `unknown` is what an undeclared tool call
    // produces, and there are no declarations until Phase 7 (principle 7).
    expect(["clean", "dirty", "unknown"]).toContain(
      at(preview, "cleanliness.state"),
    );

    const forked = await harness.ok(`/sessions/${sessionId}/fork`, {
      method: "POST",
      body: { turn: 1, initiationKey: "fork-1" },
    });

    // A new session, in a new workstream of its own (§6.3).
    expect(at(forked, "session.id")).not.toBe(sessionId);
    expect(at(forked, "workstreamId")).not.toBe(workstream);
    // The mode recorded is the branch that ran, not the branch that was planned.
    expect(at(forked, "mode")).toBe("seeded");

    // Its own workspace record, and provenance from the source (§3.7).
    const snapshot = await harness.ok("/snapshot");
    const provenance = list(snapshot, "edges").filter(
      (edge) => at(edge, "relation") === "session_forked_from",
    );
    expect(provenance).toHaveLength(1);

    const workstreams = list(snapshot, "workstreams").map((one) =>
      at(one, "id"),
    );
    expect(workstreams).toContain(str(forked, "workstreamId"));

    // One gesture, one fork (principle 9).
    const again = await harness.call(`/sessions/${sessionId}/fork`, {
      method: "POST",
      body: { turn: 1, initiationKey: "fork-1" },
    });
    expect(again.status).toBe(200);
    expect(at(again.body, "replayed")).toBe(true);
  });

  it("refuses a turn the transcript does not have", async () => {
    const harness = await bootWith(twoTurns);
    const { sessionId } = await endedTwoTurnSession(harness);

    const refused = await harness.call(`/sessions/${sessionId}/fork`, {
      method: "POST",
      body: { turn: 99, initiationKey: "fork-nowhere" },
    });

    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("unknown_point");
  });

  it("forks a running session, which is a fork and not a stop", async () => {
    const harness = await bootWith(twoTurns);
    const fixture = await command(harness, { lifecycle: "open" });
    const sessionId = str(
      await run(harness, fixture.commandId, twoTurns),
      "session.id",
    );
    await waitFor(async () => {
      const transcript = await harness.ok(`/sessions/${sessionId}/transcript`);
      return list(transcript, "turns").length >= 1 ? transcript : null;
    }, "the first turn to be recorded");

    // Forking does not require the source to have stopped: §6.3's fork is "from any
    // point", and the source carries on. Only a *deleted* source is refused.
    const forked = await harness.ok(`/sessions/${sessionId}/fork`, {
      method: "POST",
      body: { turn: 1, initiationKey: "fork-live" },
    });

    expect(at(forked, "session.id")).not.toBe(sessionId);
    const source = await harness.ok(`/sessions/${sessionId}`);
    expect(at(source, "session.end")).toBeNull();
  });
});

describe("handoff (§6.3)", () => {
  it("drafts, reviews, and sends — and refuses sending an unreviewed brief", async () => {
    const harness = await bootWith(twoTurns);
    const { sessionId } = await endedTwoTurnSession(harness);
    const target = await command(harness, {
      lifecycle: "open",
      name: "Receiving",
    });

    const drafted = await harness.ok(`/sessions/${sessionId}/handoff-brief`, {
      method: "POST",
      body: { text: "here is where I got to, and what is left" },
    });
    const briefId = str(drafted, "brief.id");
    expect(at(drafted, "brief.state")).toBe("drafted");

    // Sending an unreviewed brief is what §6.3 forbids. The type refuses it in
    // core; the endpoint says so in words, because "review it first" is actionable.
    const unreviewed = await harness.call("/handoffs", {
      method: "POST",
      body: {
        briefId,
        workstreamId: target.workstream,
        initiationKey: "handoff-early",
      },
    });
    expect(unreviewed.status).toBe(409);
    expect(at(unreviewed.body, "error.details.reason")).toBe(
      "brief_not_reviewed",
    );

    // A session cannot review its own brief: that is the review not happening.
    const bySession = await harness.call(`/handoff-briefs/${briefId}/review`, {
      method: "POST",
      body: {},
      actor: `session:${sessionId}`,
    });
    expect(bySession.status).toBe(409);
    expect(at(bySession.body, "error.details.reason")).toBe("human_only");

    const reviewed = await harness.ok(`/handoff-briefs/${briefId}/review`, {
      method: "POST",
      body: { text: "here is where I got to — and mind the migration" },
    });
    expect(at(reviewed, "brief.state")).toBe("reviewed");
    // Whether the human changed the words is recorded, because it is worth knowing.
    expect(at(reviewed, "brief.edited")).toBe(true);

    const sent = await harness.ok("/handoffs", {
      method: "POST",
      body: {
        briefId,
        workstreamId: target.workstream,
        initiationKey: "handoff-1",
      },
    });

    const newSessionId = str(sent, "session.id");
    expect(newSessionId).not.toBe(sessionId);

    // The brief is on the graph, wired into the new session by the **reviewer** —
    // the human decided this session should know this (§15-2).
    const snapshot = await harness.ok("/snapshot");
    const edge = list(snapshot, "edges").find(
      (candidate) =>
        at(candidate, "kind") === "context" &&
        at(candidate, "from") === str(sent, "briefNodeId"),
    );
    expect(at(edge, "author.kind")).toBe("human");

    const provenance = list(snapshot, "edges").filter(
      (candidate) => at(candidate, "relation") === "session_handoff",
    );
    expect(provenance).toHaveLength(1);

    // And it cannot be sent twice.
    const twice = await harness.call("/handoffs", {
      method: "POST",
      body: {
        briefId,
        workstreamId: target.workstream,
        initiationKey: "handoff-2",
      },
    });
    expect(twice.status).toBe(409);
    expect(at(twice.body, "error.details.reason")).toBe("already_sent");
  });

  it("derives a brief from the log when the session wrote none", async () => {
    const harness = await bootWith(twoTurns);
    const { sessionId } = await endedTwoTurnSession(harness);

    const derived = await harness.ok(`/sessions/${sessionId}/handoff-brief`, {
      method: "POST",
      body: {},
    });

    // Labelled as derived, paraphrasing nothing, and authored by nobody: `Author`
    // has no system variant, and inventing one would leak an unattributed author
    // onto the graph (§15-2).
    expect(at(derived, "brief.origin")).toBe("derived");
    expect(at(derived, "brief.draftedBy")).toBeNull();
    expect(String(at(derived, "brief.text"))).toContain("derived");
  });
});

describe("continue versus fresh (§4.3)", () => {
  it("describes both options, and the one it refuses", async () => {
    const harness = await bootWith(twoTurns);
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "the work" }],
    });

    // Before anything ran: only fresh exists, and the comparison says so rather
    // than offering a continuation of nothing.
    const before = await harness.ok(
      `/commands/${fixture.commandId}/continuation`,
    );
    expect(at(before, "continue.available")).toBe(false);
    expect(at(before, "fresh.available")).toBe(true);

    const sessionId = str(
      await run(harness, fixture.commandId, twoTurns),
      "session.id",
    );
    await waitFor(async () => {
      const transcript = await harness.ok(`/sessions/${sessionId}/transcript`);
      return list(transcript, "turns").length >= 1 ? transcript : null;
    }, "a turn to exist");

    const live = await harness.ok(
      `/commands/${fixture.commandId}/continuation`,
    );

    // Continuing a live session is the cheap path (§4.3), and the basis is input
    // tokens rather than invented money.
    expect(at(live, "comparison.basis")).toBe("input-tokens");
    expect(at(live, "continue.available")).toBe(true);
    // Both options are described whatever the verdict — a preview that hid the
    // option it rejected could not be argued with.
    expect(at(live, "fresh.available")).toBe(true);
    expect(typeof at(live, "forcedFresh")).toBe("boolean");
    expect(at(live, "windowFit")).not.toBeNull();
  });

  it("forces fresh when the workspace diverged", async () => {
    const harness = await bootWith(twoTurns);
    const fixture = await command(harness, { lifecycle: "open" });
    const sessionId = str(
      await run(harness, fixture.commandId, twoTurns),
      "session.id",
    );
    await harness.ok(`/sessions/${sessionId}/stop`, {
      method: "POST",
      body: {},
    });
    await endedSession(harness, sessionId);

    divergeWorkspace(harness, fixture.workstream);

    const compared = await harness.ok(
      `/commands/${fixture.commandId}/continuation`,
    );

    // §4.3: "workspace divergence forces fresh" — and the refused option still
    // says why, in the gate's own words.
    expect(at(compared, "forcedFresh")).toBe(true);
    expect(at(compared, "recommended")).toBe("fresh");
    expect(at(compared, "continue.available")).toBe(false);
    expect(list(compared, "continue.blocks").length).toBeGreaterThan(0);
  });
});
