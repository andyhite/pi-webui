import type { PluginModule } from "../protocol.js";

const plugin: PluginModule = {
  name: "healthy",
  ping: (payload) => `pong:${payload}`,
};

export default plugin;
