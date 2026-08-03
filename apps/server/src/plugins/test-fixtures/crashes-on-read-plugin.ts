/**
 * A plugin that kills its own worker mid-call: the crash half of §10.2's isolation
 * matrix, as opposed to the throw half.
 *
 * The host restarts a plugin that had loaded, bounded (`DEFAULT_RESTART_POLICY`), and
 * gives up saying so — a crash is never an infinite restart (principle 11), and it
 * is never the host's own process going down.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

const manifest: PluginManifest = {
  id: "crashes-on-read",
  name: "Crashes on read",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [],
  contributions: {
    conceptProducers: [
      {
        id: "crashing-tickets",
        kinds: ["ticket"],
        refresh: { kind: "on-demand" },
        scoping: { language: "none", example: "" },
        permissions: [],
        read() {
          process.exit(7);
        },
      },
    ],
  },
};

export default manifest;
