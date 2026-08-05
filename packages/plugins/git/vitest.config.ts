import { defineConfig, mergeConfig } from "vitest/config";

import { packageTests } from "../../../vitest.base.config.js";

// One deviation from the shared configuration: this suite spawns real `git`
// processes against temporary repositories, which does not fit vitest's
// default 5s.
export default mergeConfig(
  packageTests,
  defineConfig({ test: { testTimeout: 30_000 } }),
);
