import type { PluginModule } from "../protocol.js";

// Never settles, and the interval keeps the worker's event loop alive: a
// genuine hang the host's load timeout must catch (§10.2 "hangs").
await new Promise<never>(() => {
  setInterval(() => undefined, 1_000);
});

const plugin: PluginModule = {
  name: "unreachable",
  ping: () => "unreachable",
};

export default plugin;
