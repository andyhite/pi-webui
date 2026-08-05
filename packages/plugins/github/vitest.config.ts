import { defineConfig, mergeConfig } from "vitest/config";

import { packageTests } from "../../../vitest.base.config.js";

// One deviation from the shared configuration: this suite loads the built
// plugin in a worker and serves it a local HTTP fixture, which does not fit
// vitest's default 5s.
export default mergeConfig(
  packageTests,
  defineConfig({ test: { testTimeout: 30_000 } }),
);
