import type { PluginManifest } from "../contract/manifest.js";

// A throw is a fault, not a result (§10.2): the plugin degrades to unavailable.
const manifest: PluginManifest = {
  id: "thrower",
  name: "Thrower",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [],
  contributions: {
    agentTools: [
      {
        name: "boom",
        summary: "throws",
        input: {},
        output: { description: "nothing" },
        requires: { mutates: false, writeActionId: null, permissions: [] },
        call: () => {
          throw new Error("boom on call");
        },
      },
    ],
  },
};

export default manifest;
