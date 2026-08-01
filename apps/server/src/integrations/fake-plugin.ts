import type { draft } from "@plotroom/plugin-sdk";
import type { IntegrationProducer } from "./registry.js";

/**
 * The fake/test integration (Epic 7.2 scope item 5).
 *
 * An in-repo fixture, usable without the finished plugin host — coordinate with
 * Track C's own test plugin at rebase; if C's host lands mid-batch, this is
 * ported onto it, and until then it is invoked directly through
 * {@link IntegrationRegistry}. **Say so, not paper over it**: nothing here
 * proves a worker-isolated plugin behaves — it proves the substrate around one
 * (refresh scheduling, reconciliation, write-action approval routing, read-back
 * honesty) behaves, against a producer shaped exactly like the draft contract
 * says a real one will be.
 *
 * State is in-memory and mutated by calls, so a test can drive scenarios
 * (a record changing between refreshes, a source going unavailable, a write
 * that does something other than what was asked) without a real API.
 */
export interface FakeTicket {
  externalId: string;
  title: string;
  status: string;
  body: string;
}

export interface FakeIntegrationState {
  readonly tickets: Map<string, FakeTicket>;
  /** Set true to make every `read` throw, simulating a broken connection. */
  failReads: boolean;
  failReason: string;
}

export function createFakeIntegrationState(
  seed: readonly FakeTicket[] = [],
): FakeIntegrationState {
  return {
    tickets: new Map(seed.map((ticket) => [ticket.externalId, ticket])),
    failReads: false,
    failReason: "authentication failed",
  };
}

function renderTicket(ticket: FakeTicket): draft.DraftProducedObject {
  return {
    kind: "ticket",
    externalId: ticket.externalId,
    title: ticket.title,
    renderings: {
      card: JSON.stringify({ status: ticket.status }),
      summary: `${ticket.externalId} · ${ticket.status}`,
      agentContent: `${ticket.title}\n\n${ticket.body}`,
    },
  };
}

/**
 * The fake concept producer: `DraftConceptProducer`, declared `interval` so the
 * refresh-job tests exercise the schedule, with an opaque scoping query it
 * never parses (§9.1).
 */
export function createFakeProducer(
  state: FakeIntegrationState,
  options: { readonly refreshSeconds?: number } = {},
): IntegrationProducer {
  return {
    id: "fake-tickets",
    pluginId: "fake-plugin",
    kinds: ["ticket"],
    refresh: { kind: "interval", seconds: options.refreshSeconds ?? 300 },
    scoping: { language: "fake-ql", example: 'status = "open"' },

    async read(
      request: draft.DraftReadRequest,
    ): Promise<draft.DraftReadResult> {
      if (state.failReads) {
        throw new Error(state.failReason);
      }

      const wanted =
        request.externalId === null
          ? [...state.tickets.values()]
          : [state.tickets.get(request.externalId)].filter(
              (ticket): ticket is FakeTicket => ticket !== undefined,
            );

      const unavailable =
        request.externalId !== null && wanted.length === 0
          ? [
              {
                externalId: request.externalId,
                why: "no ticket with that id in the fake source",
              },
            ]
          : [];

      return {
        objects: wanted.map(renderTicket),
        unavailable,
      };
    },

    writeActions: [fakeCommentAction(state), fakeCloseAction(state)],
  };
}

/**
 * A reversible write action whose `perform` deliberately does not do exactly
 * what was asked — appends a system note the caller did not request — so the
 * read-back proves the substrate reports what *actually* happened rather than
 * assuming the input described it (§9.2, scope item 3 and 6: "tested with a
 * fake plugin whose write mutates differently than asked").
 */
function fakeCommentAction(
  state: FakeIntegrationState,
): draft.DraftWriteAction {
  return {
    id: "comment",
    action: "comment",
    system: "fake",
    reversibility: "reversible",
    input: {
      externalId: { type: "string", required: true, description: "ticket id" },
      text: { type: "string", required: true, description: "comment text" },
    },
    async perform(rawInput: unknown): Promise<draft.DraftWriteResult> {
      const input = rawInput as { externalId: string; text: string };
      const ticket = state.tickets.get(input.externalId);
      if (ticket === undefined) {
        return {
          ok: false,
          message: `no ticket ${input.externalId} in the fake source`,
          readBack: null,
        };
      }

      // Mutates differently than asked: the caller asked to comment "text",
      // but the fake source also appends a note nobody requested — exactly the
      // divergence a read-back (never assumed) has to surface honestly.
      ticket.body = `${ticket.body}\n\n[comment] ${input.text}\n[system] comment relayed by fake-plugin, not verbatim`;

      return {
        ok: true,
        message: "comment accepted",
        readBack: renderTicket(ticket),
      };
    },
  };
}

/** An irreversible write action, so the approval-piercing path has one to hit. */
function fakeCloseAction(state: FakeIntegrationState): draft.DraftWriteAction {
  return {
    id: "close",
    action: "close",
    system: "fake",
    reversibility: "irreversible",
    input: {
      externalId: { type: "string", required: true, description: "ticket id" },
    },
    async perform(rawInput: unknown): Promise<draft.DraftWriteResult> {
      const input = rawInput as { externalId: string };
      const ticket = state.tickets.get(input.externalId);
      if (ticket === undefined) {
        return {
          ok: false,
          message: `no ticket ${input.externalId} in the fake source`,
          readBack: null,
        };
      }
      ticket.status = "closed";
      return {
        ok: true,
        message: "closed",
        readBack: renderTicket(ticket),
      };
    },
  };
}
