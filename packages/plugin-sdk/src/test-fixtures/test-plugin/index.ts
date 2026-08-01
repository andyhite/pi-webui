/**
 * The in-repo conformance fixture: a plugin that contributes to every one of the
 * twelve §10.1 points and answers every dispatchable one.
 *
 * It exists so the batch gate has something real to run and so the contract's
 * claims are proved rather than asserted: the actor a tool sees is the calling
 * session's, a credential it echoes comes back redacted, and an ungranted
 * contribution is refused before the worker is reached.
 *
 * It imports **types only** from the SDK, because a fixture is executed straight
 * from `src/` by Node's type stripping, where `../../contract/index.js` does not
 * exist on disk. That is also the honest test of the contract: a plugin author
 * needs nothing at runtime from the SDK.
 */
import type { PluginManifest } from "../../contract/manifest.js";

const manifest: PluginManifest = {
  id: "test-plugin",
  name: "Contract fixture",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [
    {
      id: "api",
      kind: "network",
      scope: { kind: "network", hosts: ["example.invalid"] },
      reason: "read fixture tickets",
      requiredToLoad: false,
    },
    {
      id: "token",
      kind: "credential",
      scope: {
        kind: "credential",
        credentialId: "fixture-token",
        system: "example",
      },
      reason: "authenticate to the fixture system",
      requiredToLoad: false,
    },
    {
      id: "never-granted",
      kind: "core-capability",
      scope: { kind: "core-capability", capability: "notify" },
      reason: "prove an ungranted permission refuses",
      requiredToLoad: false,
    },
  ],
  contributions: {
    conceptProducers: [
      {
        id: "tickets",
        kinds: ["ticket"],
        refresh: { kind: "on-demand" },
        scoping: { language: "fixture-query", example: "project = FIX" },
        permissions: ["api"],
        read: (request) => ({
          objects: [
            {
              kind: "ticket" as const,
              externalId: request.externalId ?? "FIX-1",
              title: "a fixture ticket",
              renderings: {
                card: "FIX-1",
                summary: "a fixture ticket",
                agentContent: `scope=${request.scope ?? "none"}`,
              },
            },
          ],
          unavailable: [],
        }),
      },
    ],
    writeActions: [
      {
        id: "transition",
        action: "transition",
        system: "example",
        reversibility: "reversible",
        input: {
          externalId: {
            type: "string" as const,
            required: true,
            description: "the ticket",
          },
        },
        permissions: ["api"],
        perform: (input) => ({
          ok: true,
          message: `transitioned ${JSON.stringify(input)}`,
          readBack: null,
        }),
      },
    ],
    agentTools: [
      {
        name: "fixture_echo",
        summary: "echo the input back",
        input: {
          text: {
            type: "string" as const,
            required: true,
            description: "what to echo",
          },
        },
        output: { description: "the same text" },
        requires: { mutates: false, writeActionId: null, permissions: [] },
        call: (input, context) => {
          context.log("echoing");
          return { ok: true, content: JSON.stringify(input) };
        },
      },
      {
        name: "fixture_whoami",
        summary: "report the actor the host supplied",
        input: {},
        output: { description: "the calling session, as the host stated it" },
        requires: { mutates: false, writeActionId: null, permissions: [] },
        // A plugin cannot choose an actor; all it can do is report the one it was
        // given (principle 1).
        call: (_input, context) => ({
          ok: true,
          content: JSON.stringify(context.actor),
        }),
      },
      {
        name: "fixture_leak",
        summary: "echo its injected credential, which the host must redact",
        input: {},
        output: { description: "a redacted credential" },
        requires: {
          mutates: false,
          writeActionId: null,
          permissions: ["token"],
        },
        call: (_input, context) => ({
          ok: true,
          content: `token=${context.credentials["fixture-token"] ?? "none"}`,
        }),
      },
      {
        name: "fixture_context_keys",
        summary: "report every name the host injected into the call context",
        input: {},
        output: { description: "the complete reach a plugin is given" },
        requires: { mutates: false, writeActionId: null, permissions: [] },
        call: (_input, context) => ({
          ok: true,
          content: Object.keys(context).sort().join(","),
        }),
      },
      {
        name: "fixture_notify",
        summary: "needs a permission the operator never answered",
        input: {},
        output: { description: "nothing; it is refused" },
        requires: {
          mutates: false,
          writeActionId: null,
          permissions: ["never-granted"],
        },
        call: () => ({ ok: true, content: "should never run" }),
      },
    ],
    contentRenderers: [
      {
        id: "ticket-content",
        kinds: ["ticket"],
        renderAgentContent: (object) => ({
          content: object.renderings.agentContent,
          truncated: null,
        }),
        renderDelta: (previous, next) => ({
          content: `${previous.title} -> ${next.title}`,
          truncated: { omittedBytes: 12, why: "fixture cap" },
        }),
      },
    ],
    cardRenderers: [
      {
        id: "ticket-card",
        kinds: ["ticket"],
        renderCard: (object, detail) => ({
          title: object.title,
          lines: detail === "expanded" ? [object.renderings.summary] : [],
          actions: [
            {
              id: "transition",
              label: "Transition",
              writeActionId: "transition",
            },
          ],
        }),
      },
    ],
    panels: [
      {
        id: "fixture-panel",
        title: "Fixture",
        placement: "right",
        render: () => ({ title: "Fixture", lines: [], actions: [] }),
      },
    ],
    paletteEntries: [
      {
        id: "fixture-entry",
        label: "Fixture: do nothing",
        description: "proves a palette entry can be contributed",
        invoke: () => undefined,
      },
    ],
    workspaceKinds: [
      {
        id: "fixture-workspace",
        label: "Fixture workspace",
        permissions: [],
        checkConfig: () => ({ valid: true }),
        provision: (request) => ({
          provisioned: true,
          roots: [{ rootKey: "root", path: "/tmp/fixture" }],
          cost: {
            elapsedMillis: 1,
            bytesOnDisk: null,
            sharedCache: "unavailable",
            strategy: "fixture",
          },
          log: [`provisioned ${request.workspaceId}`],
          notes: [],
        }),
        runSetup: (request) => ({
          ok: true,
          exitCode: 0,
          output: "",
          finishedAt: request.startedAt,
        }),
        status: () => ({
          observedAt: 0,
          readiness: "ready",
          units: [],
          unavailable: null,
        }),
        fingerprint: () => ({ observedAt: 0, units: [] }),
        remove: () => ({ removed: true, log: [] }),
      },
    ],
    conditionChecks: [
      {
        id: "fixture-met",
        summary: "always met, with evidence",
        input: {},
        permissions: [],
        // Reports the actor so a test can prove a non-tool call acts as nobody.
        check: (_input, context) => ({
          state: "met",
          evidence: `actor=${JSON.stringify(context.actor)}`,
        }),
      },
    ],
    notificationRoutes: [
      {
        id: "fixture-route",
        label: "Fixture route",
        permissions: [],
        send: () => undefined,
      },
    ],
    commandDefinitions: [
      {
        id: "fixture-command",
        name: "Fixture command",
        instruction: "do the fixture thing",
        lifecycle: "producing",
        expectedOutcome: "a fixture artifact exists",
        conditionCheckIds: ["fixture-met"],
      },
    ],
    themes: [
      {
        id: "fixture-theme",
        name: "Fixture",
        tokens: { "color-bg": "#000000" },
      },
    ],
  },
};

export default manifest;
