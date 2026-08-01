import { describe, expect, it } from "vitest";
import {
  humanAuthor,
  INHERIT_APP_TOOLS,
  startSession,
  type CommandDefinition,
  type CommandNode,
  type CommandOutput,
  type Edge,
  type PlacedNode,
  type PlotObject,
  type Session,
  type Workstream,
} from "@plotroom/core";
import { makeRun } from "@plotroom/core/testing";

import type { CanvasCardView } from "../canvas/PlotCanvas.js";
import { emptyBoardState, stateFromSnapshot } from "./board-state.js";
import type { RawSnapshot } from "./board-state.js";
import { buildGraphSnapshot } from "./build-snapshot.js";

function testSession(overrides: Partial<Session> = {}): Session {
  const session = startSession(
    {
      id: "sess_1" as Session["id"],
      workstreamId: "ws_1" as Session["workstreamId"],
      commandId: null,
      mode: "open",
      launch: {
        model: "fixture-model",
        effort: "medium",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      initiatedBy: humanAuthor,
      runtime: { adapterId: "scripted", ref: "scripted-1" },
    },
    1_000,
  );
  return { ...session, ...overrides };
}

function rawSnapshot(overrides: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    seq: 0,
    workstreams: [],
    nodes: [],
    edges: [],
    objects: [],
    commandDefinitions: [],
    commands: [],
    outputs: [],
    sessions: [],
    ...overrides,
  };
}

const ticket: PlotObject = {
  id: "obj_ticket" as PlotObject["id"],
  kind: "ticket",
  scope: "world",
  workstreamId: null,
  external: null,
  title: "ticket OXY-1",
  latestVersionId: "v1" as PlotObject["latestVersionId"],
  createdAt: 0,
  promotedAt: null,
};

describe("buildGraphSnapshot", () => {
  it("returns nothing for an empty board", () => {
    const snapshot = buildGraphSnapshot(emptyBoardState(), new Map());
    expect(snapshot).toEqual({
      nodes: [],
      edges: [],
      containers: [],
      warningFacts: new Map(),
      paletteEntries: [],
      contextEdges: [],
    });
  });

  it("labels a content node from the object it stands for", () => {
    const node: PlacedNode = {
      id: "n1" as PlacedNode["id"],
      role: "content",
      refId: ticket.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ objects: [ticket], nodes: [node] }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.nodes).toEqual([
      expect.objectContaining({
        id: "n1",
        label: "ticket OXY-1",
        role: "content",
      }),
    ]);
  });

  it("labels a content node standing for an unbound output placeholder", () => {
    const output: CommandOutput = {
      id: "out_1" as CommandOutput["id"],
      commandId: "cmd_1" as CommandOutput["commandId"],
      name: "review",
      kind: "review",
      publishedAt: null,
      boundObjectId: null,
      boundRunId: null,
      boundAt: null,
      brokenAt: null,
    };
    const node: PlacedNode = {
      id: "n_out" as PlacedNode["id"],
      role: "content",
      refId: output.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ outputs: [output], nodes: [node] }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.nodes[0]?.label).toBe("output: review");
    expect(snapshot.warningFacts.get("n_out")).toEqual({
      producedOutput: false,
      published: false,
    });
  });

  it("marks a produced, published output's facts accordingly", () => {
    const output: CommandOutput = {
      id: "out_2" as CommandOutput["id"],
      commandId: "cmd_1" as CommandOutput["commandId"],
      name: "review",
      kind: "review",
      publishedAt: 1,
      boundObjectId: "obj_bound" as CommandOutput["boundObjectId"],
      boundRunId: "run_1" as CommandOutput["boundRunId"],
      boundAt: 1,
      brokenAt: null,
    };
    const node: PlacedNode = {
      id: "n_out2" as PlacedNode["id"],
      role: "content",
      refId: output.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ outputs: [output], nodes: [node] }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.warningFacts.get("n_out2")).toEqual({
      producedOutput: true,
      published: true,
    });
  });

  it("labels a command node from its definition's name", () => {
    const definition: CommandDefinition = {
      id: "def_1" as CommandDefinition["id"],
      name: "implement",
      instruction: "do it",
      model: { model: "x", effort: "medium" },
      permissions: { allowed: [], denied: [] },
      askPoints: [],
      lifecycle: "open",
      outcome: null,
      parameters: [],
      budget: {
        modelWindowTokens: 200_000,
        warnAtFraction: 0.85,
        hardCapTokens: null,
      },
      source: "user",
      folder: null,
      duplicatedFrom: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const command: CommandNode = {
      id: "cmd_1" as CommandNode["id"],
      definitionId: definition.id,
      workstreamId: "ws_1" as CommandNode["workstreamId"],
      createdAt: 0,
      deletedAt: null,
    };
    const node: PlacedNode = {
      id: "n_cmd" as PlacedNode["id"],
      role: "command",
      refId: command.id,
      workstreamId: "ws_1" as PlacedNode["workstreamId"],
      createdAt: 0,
      deletedAt: null,
    };
    const state = stateFromSnapshot(
      rawSnapshot({
        commandDefinitions: [definition],
        commands: [command],
        nodes: [node],
      }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.nodes[0]).toEqual(
      expect.objectContaining({
        id: "n_cmd",
        label: "command: implement",
        role: "command",
        containerId: "ws_1",
      }),
    );
  });

  it("labels a command node with its latest run's status, when one exists", () => {
    const definition: CommandDefinition = {
      id: "def_1" as CommandDefinition["id"],
      name: "implement",
      instruction: "do it",
      model: { model: "x", effort: "medium" },
      permissions: { allowed: [], denied: [] },
      askPoints: [],
      lifecycle: "open",
      outcome: null,
      parameters: [],
      budget: {
        modelWindowTokens: 200_000,
        warnAtFraction: 0.85,
        hardCapTokens: null,
      },
      source: "user",
      folder: null,
      duplicatedFrom: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const command: CommandNode = {
      id: "cmd_1" as CommandNode["id"],
      definitionId: definition.id,
      workstreamId: "ws_1" as CommandNode["workstreamId"],
      createdAt: 0,
      deletedAt: null,
    };
    const node: PlacedNode = {
      id: "n_cmd" as PlacedNode["id"],
      role: "command",
      refId: command.id,
      workstreamId: "ws_1" as PlacedNode["workstreamId"],
      createdAt: 0,
      deletedAt: null,
    };
    const olderRun = makeRun({
      commandId: command.id,
      ordinal: 1,
      status: "failed",
    });
    const latestRun = makeRun({
      commandId: command.id,
      ordinal: 2,
      status: "running",
    });

    const state = stateFromSnapshot(
      rawSnapshot({
        commandDefinitions: [definition],
        commands: [command],
        nodes: [node],
      }),
    );
    // Runs never travel with the snapshot (unbounded history); a board only
    // learns of one from a live `run` event.
    const withRuns = {
      ...state,
      runs: new Map([
        [olderRun.id, olderRun],
        [latestRun.id, latestRun],
      ]),
    };

    const snapshot = buildGraphSnapshot(withRuns, new Map());
    expect(snapshot.nodes[0]?.label).toBe("command: implement — run: running");
  });

  it("labels a session node with its live phase, and derives running from the session record", () => {
    const running = testSession();
    const node: PlacedNode = {
      id: "n_sess" as PlacedNode["id"],
      role: "session",
      refId: running.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
      // Stale on purpose: the node's own flag says not running, but the
      // live session record (still open, no `end`) must win.
      running: false,
    };
    const state = stateFromSnapshot(rawSnapshot({ nodes: [node] }));
    const withSession = {
      ...state,
      sessions: new Map([
        [
          running.id,
          { session: running, phase: { kind: "thinking" as const } },
        ],
      ]),
    };

    const snapshot = buildGraphSnapshot(withSession, new Map());
    expect(snapshot.nodes[0]).toEqual(
      expect.objectContaining({
        label: `session ${running.id} (thinking)`,
        running: true,
      }),
    );
  });

  it("falls back to the node's own running flag before a session record has arrived", () => {
    const node: PlacedNode = {
      id: "n_sess" as PlacedNode["id"],
      role: "session",
      refId: "sess_unknown",
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
      running: true,
    };
    const state = stateFromSnapshot(rawSnapshot({ nodes: [node] }));
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.nodes[0]).toEqual(
      expect.objectContaining({
        label: "session sess_unknown",
        running: true,
      }),
    );
  });

  it("flags a bare ticket (no workstream) as accepting a dropped definition", () => {
    const node: PlacedNode = {
      id: "n_bare" as PlacedNode["id"],
      role: "content",
      refId: ticket.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ objects: [ticket], nodes: [node] }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.nodes[0]?.acceptsDefinitionDrop).toBe(true);
  });

  it("does not flag a ticket already inside a workstream", () => {
    const node: PlacedNode = {
      id: "n_in_ws" as PlacedNode["id"],
      role: "content",
      refId: ticket.id,
      workstreamId: "ws_1" as PlacedNode["workstreamId"],
      createdAt: 0,
      deletedAt: null,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ objects: [ticket], nodes: [node] }),
    );
    expect(
      buildGraphSnapshot(state, new Map()).nodes[0]?.acceptsDefinitionDrop,
    ).toBe(false);
  });

  it("names a workstream container from its subject object's title", () => {
    const workstream: Workstream = {
      id: "ws_1" as Workstream["id"],
      subjectId: ticket.id,
      status: "active",
      archivedAt: null,
      createdAt: 0,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ workstreams: [workstream], objects: [ticket] }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.containers).toEqual([
      expect.objectContaining({
        id: "ws_1",
        label: "workstream: ticket OXY-1",
      }),
    ]);
  });

  it("derives context edges from context-kind edges only, carrying ordinal", () => {
    const contextEdge: Edge = {
      id: "e1" as Edge["id"],
      kind: "context",
      from: "a" as PlacedNode["id"],
      to: "b" as PlacedNode["id"],
      author: { kind: "human" },
      ordinal: 2,
      createdAt: 0,
    };
    const provenanceEdge: Edge = {
      id: "e2" as Edge["id"],
      kind: "provenance",
      from: "c" as PlacedNode["id"],
      to: "d" as PlacedNode["id"],
      relation: "command_declares_output",
      createdAt: 0,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ edges: [contextEdge, provenanceEdge] }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.contextEdges).toEqual([
      { id: "e1", from: "a", to: "b", ordinal: 2 },
    ]);
    // But every edge still draws on the canvas, regardless of kind.
    expect(snapshot.edges.map((edge) => edge.id).sort()).toEqual(["e1", "e2"]);
  });

  it("assembles a command's real content in ordinal order for the fifth §5 warning", () => {
    const source1: PlacedNode = {
      id: "n_src1" as PlacedNode["id"],
      role: "content",
      refId: "obj_1",
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const source2: PlacedNode = {
      id: "n_src2" as PlacedNode["id"],
      role: "content",
      refId: "obj_2",
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const command: PlacedNode = {
      id: "n_cmd" as PlacedNode["id"],
      role: "command",
      refId: "cmd_1",
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const edgeSecond: Edge = {
      id: "e_second" as Edge["id"],
      kind: "context",
      from: source2.id,
      to: command.id,
      author: { kind: "human" },
      ordinal: 1,
      createdAt: 0,
    };
    const edgeFirst: Edge = {
      id: "e_first" as Edge["id"],
      kind: "context",
      from: source1.id,
      to: command.id,
      author: { kind: "human" },
      ordinal: 0,
      createdAt: 0,
    };
    const state = stateFromSnapshot(
      rawSnapshot({
        nodes: [source1, source2, command],
        edges: [edgeSecond, edgeFirst],
      }),
    );
    const objectContent = new Map([
      ["obj_1", "first content"],
      ["obj_2", "second content"],
    ]);
    const snapshot = buildGraphSnapshot(state, objectContent);
    expect(snapshot.warningFacts.get("n_cmd")).toEqual({
      assembledContent: "first content\nsecond content",
    });
  });

  it("palette entries exclude anything already placed as a content node", () => {
    const placedNode: PlacedNode = {
      id: "n1" as PlacedNode["id"],
      role: "content",
      refId: ticket.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const unplaced: PlotObject = {
      ...ticket,
      id: "obj_unplaced" as PlotObject["id"],
      title: "ticket OXY-2",
    };
    const state = stateFromSnapshot(
      rawSnapshot({ objects: [ticket, unplaced], nodes: [placedNode] }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.paletteEntries).toEqual([
      {
        id: "obj_unplaced",
        kind: "ticket",
        label: "ticket OXY-2",
        blockedBy: [],
      },
    ]);
  });

  it("every live command definition is a palette entry, never a placed node itself", () => {
    const definition: CommandDefinition = {
      id: "def_1" as CommandDefinition["id"],
      name: "implement",
      instruction: "do it",
      model: { model: "x", effort: "medium" },
      permissions: { allowed: [], denied: [] },
      askPoints: [],
      lifecycle: "open",
      outcome: null,
      parameters: [],
      budget: {
        modelWindowTokens: 200_000,
        warnAtFraction: 0.85,
        hardCapTokens: null,
      },
      source: "builtin",
      folder: null,
      duplicatedFrom: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ commandDefinitions: [definition] }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.paletteEntries).toEqual([
      {
        id: "def_1",
        kind: "command_definition",
        label: "command definition: implement",
      },
    ]);
  });

  it("omits palette kinds the palette doesn't drag (notes, diffs, etc.)", () => {
    const note: PlotObject = {
      ...ticket,
      id: "obj_note" as PlotObject["id"],
      kind: "note",
    };
    const state = stateFromSnapshot(rawSnapshot({ objects: [note] }));
    expect(buildGraphSnapshot(state, new Map()).paletteEntries).toEqual([]);
  });

  it("carries a content node's concept kind, for card-renderer resolution (§10.1, §3.1)", () => {
    const node: PlacedNode = {
      id: "n1" as PlacedNode["id"],
      role: "content",
      refId: ticket.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ objects: [ticket], nodes: [node] }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.nodes[0]?.kind).toBe("ticket");
  });

  it("attaches a caller-resolved plugin card view onto its content node, keyed by node id (§10.1)", () => {
    const node: PlacedNode = {
      id: "n1" as PlacedNode["id"],
      role: "content",
      refId: ticket.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ objects: [ticket], nodes: [node] }),
    );
    const cardView: CanvasCardView = {
      title: "plugin title",
      lines: ["a line"],
      actions: [],
    };
    const snapshot = buildGraphSnapshot(
      state,
      new Map(),
      new Map([["n1", cardView]]),
    );
    expect(snapshot.nodes[0]?.cardView).toEqual(cardView);
  });

  it("leaves cardView unset when the caller resolved nothing for this node — the host's own generic rendering applies", () => {
    const node: PlacedNode = {
      id: "n1" as PlacedNode["id"],
      role: "content",
      refId: ticket.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const state = stateFromSnapshot(
      rawSnapshot({ objects: [ticket], nodes: [node] }),
    );
    const snapshot = buildGraphSnapshot(state, new Map());
    expect(snapshot.nodes[0]?.cardView).toBeUndefined();
  });
});
