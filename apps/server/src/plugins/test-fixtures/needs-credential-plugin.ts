/**
 * A plugin that declares a credential permission and a producer that needs it.
 *
 * The three states of §10.2's permission model are all reachable through this one
 * fixture, which is why it exists: **never-asked** (the reach raises through §6.6 and
 * the call stays blocked), **granted** (the host injects the stored value for that one
 * call, and redacts it back out of the result), and **denied** (the call is refused
 * and nothing is raised, because it was answered).
 *
 * Its producer echoes *whether* a credential arrived, never the value: a fixture that
 * returned its token would be testing redaction by leaking, and the host would replace
 * it with a marker anyway.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

const manifest: PluginManifest = {
  id: "needs-credential",
  name: "Needs a credential",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [
    {
      id: "fake-token",
      kind: "credential",
      scope: {
        kind: "credential",
        credentialId: "fake-token",
        system: "fake-system",
      },
      reason: "to read the fake source at all",
      requiredToLoad: false,
    },
  ],
  contributions: {
    conceptProducers: [
      {
        id: "credentialed-tickets",
        kinds: ["ticket"],
        refresh: { kind: "on-demand" },
        scoping: { language: "none", example: "" },
        permissions: ["fake-token"],
        read(_request, context) {
          const token = context.credentials["fake-token"] ?? "";
          return {
            objects: [
              {
                kind: "ticket",
                externalId: "CRED-1",
                title: "Read with a credential",
                renderings: {
                  card: JSON.stringify({ credentialArrived: token !== "" }),
                  summary:
                    token === "" ? "no credential" : "credential injected",
                  // The value itself, deliberately, so the test can prove the host
                  // redacts it rather than trusting that nothing echoes it (§9.3).
                  agentContent: `token=${token}`,
                },
              },
            ],
            unavailable: [],
          };
        },
      },
    ],
  },
};

export default manifest;
