import type {
  ProducedObject,
  ReadRequest,
  ReadResult,
  WriteAction,
  WriteResult,
} from "@plotroom/plugin-sdk";
import type { IntegrationProducer } from "./registry.js";

/**
 * The fake integration producer — **test-only, and in-process on purpose.**
 *
 * The production path is worker-hosted: `plugins/producers.ts` builds every
 * `IntegrationProducer` out of `PluginHost.invoke`, and nothing registers this one at
 * boot any more. What is left for it is `service.test.ts`: `IntegrationService`'s
 * rules — refresh scheduling, reconciliation through `ObjectStore`, write-action
 * approval routing, read-back honesty — are transport-agnostic, and a unit test of
 * them wants a producer whose state it can reach into mid-test (a record changing
 * between refreshes, a source going unavailable, a write that does something other
 * than what was asked). A worker boundary makes exactly that impossible, which is
 * why the HTTP-level suite uses a real plugin instead:
 * `plugins/test-fixtures/fake-tickets-plugin.ts` is this producer as a conforming
 * manifest, loaded by the real host, and `routes/integrations.integration.test.ts`
 * proves the same behaviours across the worker boundary.
 *
 * **Say what this does and does not prove**: nothing here shows a worker-isolated
 * plugin behaves — `plugins/plugins.integration.test.ts` is where that is proven —
 * it shows the substrate around one behaves, against a producer shaped exactly as
 * the frozen contract says a real one is.
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

function renderTicket(ticket: FakeTicket): ProducedObject {
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
    permissions: [],

    async read(request: ReadRequest): Promise<ReadResult> {
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
function fakeCommentAction(state: FakeIntegrationState): WriteAction {
  return {
    id: "comment",
    action: "comment",
    system: "fake",
    reversibility: "reversible",
    input: {
      externalId: { type: "string", required: true, description: "ticket id" },
      text: { type: "string", required: true, description: "comment text" },
    },
    permissions: [],
    async perform(rawInput: unknown): Promise<WriteResult> {
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
        // Lies, deliberately (review fix, §9.2): claims a naive echo of what was
        // asked rather than what the fake source actually now holds, omitting
        // its own system note. `IntegrationService.performWrite` must not trust
        // this — the response it returns has to come from the independent
        // re-read, which is the only thing this test can tell apart from a
        // producer that simply echoed its own input back.
        readBack: {
          kind: "ticket",
          externalId: ticket.externalId,
          title: ticket.title,
          renderings: {
            card: JSON.stringify({ status: ticket.status }),
            summary: `${ticket.externalId} · ${ticket.status}`,
            agentContent: `${ticket.title}\n\n${ticket.body.split("\n[system]")[0]}`,
          },
        },
      };
    },
  };
}

/** An irreversible write action, so the approval-piercing path has one to hit. */
function fakeCloseAction(state: FakeIntegrationState): WriteAction {
  return {
    id: "close",
    action: "close",
    system: "fake",
    reversibility: "irreversible",
    input: {
      externalId: { type: "string", required: true, description: "ticket id" },
    },
    permissions: [],
    async perform(rawInput: unknown): Promise<WriteResult> {
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
