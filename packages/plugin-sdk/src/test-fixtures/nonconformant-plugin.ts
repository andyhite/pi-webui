import type { PluginManifest } from "../contract/manifest.js";

// A producing command definition with no expected outcome (§3.5), which the
// schema refuses natively and conformance refuses here.
const manifest = {
  id: "nonconformant",
  name: "Nonconformant",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [],
  contributions: {
    commandDefinitions: [
      {
        id: "half-declared",
        name: "Half declared",
        instruction: "do a thing",
        lifecycle: "producing",
        expectedOutcome: null,
        conditionCheckIds: [],
      },
    ],
  },
} as unknown as PluginManifest;

export default manifest;
