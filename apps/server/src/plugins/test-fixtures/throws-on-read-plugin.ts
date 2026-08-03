/**
 * A plugin that loads, conforms, and then **throws** on every producer read.
 *
 * §10.2: "a throw is a fault, not a result" — a handler that wants to report failure
 * returns `ok: false`, and one that throws makes *that plugin* unavailable with the
 * reason, while the server and every other plugin keep answering. This fixture is
 * the deliberate fault in `plugins.integration.test.ts`'s gate.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

const manifest: PluginManifest = {
  id: "throws-on-read",
  name: "Throws on read",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [],
  contributions: {
    conceptProducers: [
      {
        id: "throwing-tickets",
        kinds: ["ticket"],
        refresh: { kind: "on-demand" },
        scoping: { language: "none", example: "" },
        permissions: [],
        read() {
          throw new Error("this producer is deliberately broken");
        },
      },
    ],
  },
};

export default manifest;
