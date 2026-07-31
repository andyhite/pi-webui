import type { PluginModule } from "../protocol.js";

const plugin: PluginModule = {
  name: "hanger",
  ping: () => new Promise<string>(() => undefined),
};

export default plugin;
