import type { PluginManifest } from "../contract/manifest.js";

// Built against a contract this host does not implement: refused, with both
// numbers named (§10.2).
const manifest: PluginManifest = {
  id: "from-the-future",
  name: "From the future",
  version: "1.0.0",
  contractVersion: 99,
  permissions: [],
  contributions: {},
};

export default manifest;
