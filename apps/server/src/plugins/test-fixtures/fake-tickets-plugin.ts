/**
 * A healthy in-repository plugin, on the frozen contract v1, for the server's
 * plugin and integration-substrate tests.
 *
 * This is the **worker-hosted successor** to Epic 7.2's in-process fake producer
 * (`integrations/fake-plugin.ts`, which now serves `IntegrationService`'s unit tests
 * alone). Same producer id, same two write actions of opposite reversibility, same
 * declared interval refresh — so the HTTP-level suites that were written against the
 * direct-invocation seam now prove the same behaviour **across a worker boundary**.
 *
 * Its `comment` action keeps the property that made the old fake worth having: it
 * mutates differently than asked (it appends a system note nobody requested) and
 * self-reports a naive echo, so a read-back that is *never assumed* (§9.2) is
 * distinguishable from one that trusted the plugin.
 *
 * State is worker-local by construction. A test cannot reach in and flip a flag —
 * which is the point of the boundary — so the behaviours a test needs are addressed
 * through the **scope** (§9.1's own query language): `scope: "fail"` makes a read
 * throw, which §10.2 turns into this plugin being unavailable with a reason.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

interface Ticket {
  externalId: string;
  title: string;
  status: string;
  body: string;
}

const tickets = new Map<string, Ticket>([
  [
    "FAKE-1",
    {
      externalId: "FAKE-1",
      title: "Fix the drift flag",
      status: "open",
      body: "the original ticket body",
    },
  ],
]);

const render = (ticket: Ticket) => ({
  kind: "ticket" as const,
  externalId: ticket.externalId,
  title: ticket.title,
  renderings: {
    card: JSON.stringify({ status: ticket.status }),
    summary: `${ticket.externalId} · ${ticket.status}`,
    agentContent: `${ticket.title}\n\n${ticket.body}`,
  },
});

const manifest: PluginManifest = {
  id: "fake-plugin",
  name: "Fake tickets",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [],
  contributions: {
    conceptProducers: [
      {
        id: "fake-tickets",
        kinds: ["ticket"],
        refresh: { kind: "interval", seconds: 300 },
        scoping: { language: "fake-ql", example: 'status = "open"' },
        permissions: [],
        read(request) {
          if (request.scope === "fail") {
            // A throw is a fault, not a result (§10.2): the host degrades this
            // plugin to unavailable with this sentence as the reason.
            throw new Error("authentication failed");
          }
          const wanted =
            request.externalId === null
              ? [...tickets.values()]
              : [tickets.get(request.externalId)].filter(
                  (ticket): ticket is Ticket => ticket !== undefined,
                );
          return {
            objects: wanted.map(render),
            unavailable:
              request.externalId !== null && wanted.length === 0
                ? [
                    {
                      externalId: request.externalId,
                      why: "no ticket with that id in the fake source",
                    },
                  ]
                : [],
          };
        },
      },
    ],
    writeActions: [
      {
        id: "comment",
        action: "comment",
        system: "fake",
        reversibility: "reversible",
        input: {
          externalId: {
            type: "string",
            required: true,
            description: "ticket id",
          },
          text: { type: "string", required: true, description: "comment text" },
        },
        permissions: [],
        perform(rawInput) {
          const input = rawInput as { externalId: string; text: string };
          const ticket = tickets.get(input.externalId);
          if (ticket === undefined) {
            return {
              ok: false,
              message: `no ticket ${input.externalId} in the fake source`,
              readBack: null,
            };
          }
          ticket.body = `${ticket.body}\n\n[comment] ${input.text}\n[system] comment relayed by fake-plugin, not verbatim`;
          return {
            ok: true,
            message: "comment accepted",
            // Deliberately a naive echo, omitting the system note the source
            // actually appended: what the substrate reports must come from its
            // own re-read (§9.2), never from this claim.
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
      },
      {
        id: "close",
        action: "close",
        system: "fake",
        reversibility: "irreversible",
        input: {
          externalId: {
            type: "string",
            required: true,
            description: "ticket id",
          },
        },
        permissions: [],
        perform(rawInput) {
          const input = rawInput as { externalId: string };
          const ticket = tickets.get(input.externalId);
          if (ticket === undefined) {
            return {
              ok: false,
              message: `no ticket ${input.externalId} in the fake source`,
              readBack: null,
            };
          }
          ticket.status = "closed";
          return { ok: true, message: "closed", readBack: render(ticket) };
        },
      },
    ],
  },
};

export default manifest;
