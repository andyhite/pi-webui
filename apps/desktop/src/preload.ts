/**
 * The one bridge the renderer gets into this main process (spec §12): the
 * app badge (`app.setBadgeCount`) is main-process-only, so a renderer that
 * derived a fresh attention count (`@plotroom/ui`'s `deriveBadgeCount`) has
 * no other way to apply it. Nothing else is exposed — no filesystem, no
 * child_process, no arbitrary IPC — because widening this surface is a
 * decision this file does not get to make quietly.
 *
 * `window.plotroom` is `undefined` in a plain browser tab (the same
 * renderer served over the web, spec §12's "one origin, two ways to load
 * it") — every caller feature-detects it rather than assuming Electron.
 */

import { contextBridge, ipcRenderer } from "electron";

import { BADGE_COUNT_CHANNEL } from "./ipc-channels.js";

contextBridge.exposeInMainWorld("plotroom", {
  setBadgeCount: (count: number) => {
    ipcRenderer.send(BADGE_COUNT_CHANNEL, count);
  },
});
