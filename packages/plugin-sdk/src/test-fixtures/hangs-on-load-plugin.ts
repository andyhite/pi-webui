import type { PluginManifest } from "../contract/manifest.js";

// Never settles, and the interval keeps the worker's event loop alive: a genuine
// hang the host's load timeout must catch (§10.2 "hangs").
await new Promise<never>(() => {
  setInterval(() => undefined, 1_000);
});

const manifest: PluginManifest = {
  id: "unreachable",
  name: "Unreachable",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [],
  contributions: {},
};

export default manifest;
