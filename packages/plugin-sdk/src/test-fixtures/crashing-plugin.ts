import type { PluginManifest } from "../contract/manifest.js";

/**
 * Kills its own worker on the first call of each process, and answers afterwards.
 *
 * The attempt counter lives in a file named by `PLOTROOM_TEST_CRASH_COUNTER`
 * because a restart is a **new module instance**: state in the module would reset
 * with it, and the fixture could never prove a bounded restart succeeded.
 */
import { appendFileSync, readFileSync } from "node:fs";

const counter = process.env["PLOTROOM_TEST_CRASH_COUNTER"] ?? "";

const attempts = (): number => {
  try {
    return readFileSync(counter, "utf8").length;
  } catch {
    return 0;
  }
};

const manifest: PluginManifest = {
  id: "crasher",
  name: "Crasher",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [],
  contributions: {
    agentTools: [
      {
        name: "maybe_crash",
        summary: "crashes the worker until it has crashed once",
        input: {},
        output: { description: "the attempt number" },
        requires: { mutates: false, writeActionId: null, permissions: [] },
        call: () => {
          const attempt = attempts();
          appendFileSync(counter, "x");
          if (attempt === 0) {
            process.exit(3);
          }
          return { ok: true, content: `attempt ${attempt + 1}` };
        },
      },
    ],
  },
};

export default manifest;
