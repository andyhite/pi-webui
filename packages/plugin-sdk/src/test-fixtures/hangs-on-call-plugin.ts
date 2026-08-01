import type { PluginManifest } from "../contract/manifest.js";

const manifest: PluginManifest = {
  id: "hanger",
  name: "Hanger",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [],
  contributions: {
    agentTools: [
      {
        name: "hang",
        summary: "never answers",
        input: {},
        output: { description: "nothing, ever" },
        requires: { mutates: false, writeActionId: null, permissions: [] },
        call: () => new Promise(() => undefined),
      },
    ],
  },
};

export default manifest;
