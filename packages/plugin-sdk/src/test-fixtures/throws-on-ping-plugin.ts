import type { PluginModule } from "../protocol.js";

const plugin: PluginModule = {
  name: "thrower",
  ping: () => {
    throw new Error("boom on ping");
  },
};

export default plugin;
