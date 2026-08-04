import { describe, expect, it } from "vitest";

import { resolveDesktopConfigPath } from "./desktop-paths.js";

describe("resolveDesktopConfigPath", () => {
  it("defaults to a file inside userData", () => {
    expect(resolveDesktopConfigPath("/home/x/.config/PlotRoom", {})).toBe(
      "/home/x/.config/PlotRoom/desktop-config.json",
    );
  });

  it("honors PLOTROOM_DESKTOP_CONFIG_DIR when set", () => {
    expect(
      resolveDesktopConfigPath("/home/x/.config/PlotRoom", {
        PLOTROOM_DESKTOP_CONFIG_DIR: "/tmp/plotroom-desktop",
      }),
    ).toBe("/tmp/plotroom-desktop/desktop-config.json");
  });
});
