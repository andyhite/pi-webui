/**
 * A plugin contributing condition checks, for the leg that mounts them in the
 * server's own condition registry (§3.5, §4.3).
 *
 * `path_supplied` declares a required `path` field and answers with whatever arrived
 * in it — which is how the "**supply the workspace path in the declared input**"
 * requirement is provable rather than asserted: the condition itself declares no
 * path, so a `met` answer naming the workspace root can only have come from the
 * server filling it in.
 *
 * `never_sure` always answers `unknown`, because `unknown` is not `unmet` and neither
 * is proof: a check that could not run has not disproved completion (principle 3).
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

const manifest: PluginManifest = {
  id: "conditions-fixture",
  name: "Conditions fixture",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [],
  contributions: {
    conditionChecks: [
      {
        id: "path_supplied",
        summary: "the host supplied a workspace path in the declared input",
        input: {
          path: {
            type: "string",
            required: true,
            description: "the checkout to read, absolute",
          },
        },
        permissions: [],
        check(input) {
          const path = (input as { path?: unknown }).path;
          if (typeof path !== "string" || path === "") {
            return {
              state: "unknown",
              evidence: "no path arrived in the declared input",
            };
          }
          return { state: "met", evidence: `read ${path}` };
        },
      },
      {
        id: "never_sure",
        summary: "a check that cannot tell",
        input: {},
        permissions: [],
        check() {
          return { state: "unknown", evidence: "this check never knows" };
        },
      },
    ],
  },
};

export default manifest;
