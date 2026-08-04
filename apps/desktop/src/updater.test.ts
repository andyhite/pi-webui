import { describe, expect, it, vi } from "vitest";

import {
  checkForUpdatesNow,
  configureUpdater,
  resolveUpdateCheckIntervalHours,
} from "./updater.js";
import type { AutoUpdaterLike, UpdatePrompter } from "./updater.js";

function fakeAutoUpdater(): AutoUpdaterLike & {
  listeners: Record<string, ((arg: never) => void)[]>;
  emit: (event: string, arg?: unknown) => void;
} {
  const listeners: Record<string, ((arg: never) => void)[]> = {};
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on: (event: string, listener: (arg: never) => void) => {
      (listeners[event] ??= []).push(listener);
    },
    listeners,
    emit(event: string, arg?: unknown) {
      for (const listener of listeners[event] ?? []) listener(arg as never);
    },
  };
}

function fakePrompter(overrides: Partial<UpdatePrompter> = {}): UpdatePrompter {
  return {
    confirmDownload: vi.fn(async () => false),
    confirmInstall: vi.fn(async () => false),
    notifyError: vi.fn(),
    ...overrides,
  };
}

describe("configureUpdater", () => {
  it("does not auto-download unless autoInstallUpdates is set", () => {
    const autoUpdater = fakeAutoUpdater();
    configureUpdater({
      autoUpdater,
      prompter: fakePrompter(),
      autoInstallUpdates: false,
    });
    expect(autoUpdater.autoDownload).toBe(false);
  });

  it("auto-downloads only when the operator set autoInstallUpdates", () => {
    const autoUpdater = fakeAutoUpdater();
    configureUpdater({
      autoUpdater,
      prompter: fakePrompter(),
      autoInstallUpdates: true,
    });
    expect(autoUpdater.autoDownload).toBe(true);
  });

  it("never sets autoInstallOnAppQuit, regardless of the setting", () => {
    const autoUpdater = fakeAutoUpdater();
    configureUpdater({
      autoUpdater,
      prompter: fakePrompter(),
      autoInstallUpdates: true,
    });
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("asks before downloading when autoInstallUpdates is false", async () => {
    const autoUpdater = fakeAutoUpdater();
    const prompter = fakePrompter({ confirmDownload: vi.fn(async () => true) });
    configureUpdater({ autoUpdater, prompter, autoInstallUpdates: false });

    autoUpdater.emit("update-available", { version: "1.2.3" });
    await Promise.resolve();
    await Promise.resolve();

    expect(prompter.confirmDownload).toHaveBeenCalledWith({
      version: "1.2.3",
    });
    expect(autoUpdater.downloadUpdate).toHaveBeenCalled();
  });

  it("never downloads when the operator declines the prompt", async () => {
    const autoUpdater = fakeAutoUpdater();
    const prompter = fakePrompter({
      confirmDownload: vi.fn(async () => false),
    });
    configureUpdater({ autoUpdater, prompter, autoInstallUpdates: false });

    autoUpdater.emit("update-available", { version: "1.2.3" });
    await Promise.resolve();
    await Promise.resolve();

    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("does not prompt to download when autoInstallUpdates already covers it", async () => {
    const autoUpdater = fakeAutoUpdater();
    const prompter = fakePrompter();
    configureUpdater({ autoUpdater, prompter, autoInstallUpdates: true });

    autoUpdater.emit("update-available", { version: "1.2.3" });
    await Promise.resolve();

    expect(prompter.confirmDownload).not.toHaveBeenCalled();
  });

  it("asks before installing a downloaded update", async () => {
    const autoUpdater = fakeAutoUpdater();
    const prompter = fakePrompter({ confirmInstall: vi.fn(async () => true) });
    configureUpdater({ autoUpdater, prompter, autoInstallUpdates: true });

    autoUpdater.emit("update-downloaded", { version: "1.2.3" });
    await Promise.resolve();
    await Promise.resolve();

    expect(autoUpdater.quitAndInstall).toHaveBeenCalled();
  });

  it("never installs when the operator declines the restart prompt", async () => {
    const autoUpdater = fakeAutoUpdater();
    const prompter = fakePrompter({ confirmInstall: vi.fn(async () => false) });
    configureUpdater({ autoUpdater, prompter, autoInstallUpdates: true });

    autoUpdater.emit("update-downloaded", { version: "1.2.3" });
    await Promise.resolve();
    await Promise.resolve();

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("reports an error to the prompter without throwing", () => {
    const autoUpdater = fakeAutoUpdater();
    const prompter = fakePrompter();
    configureUpdater({ autoUpdater, prompter, autoInstallUpdates: false });

    autoUpdater.emit("error", new Error("no feed configured"));

    expect(prompter.notifyError).toHaveBeenCalled();
  });
});

describe("checkForUpdatesNow", () => {
  it("calls checkForUpdates", async () => {
    const autoUpdater = fakeAutoUpdater();
    await checkForUpdatesNow(autoUpdater);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  it("swallows a failed check rather than throwing (no feed configured yet)", async () => {
    const autoUpdater = fakeAutoUpdater();
    autoUpdater.checkForUpdates = vi.fn(async () => {
      throw new Error("no update feed configured");
    });
    await expect(checkForUpdatesNow(autoUpdater)).resolves.toBeUndefined();
  });
});

describe("resolveUpdateCheckIntervalHours", () => {
  it("defaults to 24 hours", () => {
    expect(resolveUpdateCheckIntervalHours({})).toBe(24);
  });

  it("reads PLOTROOM_UPDATE_CHECK_INTERVAL_HOURS", () => {
    expect(
      resolveUpdateCheckIntervalHours({
        PLOTROOM_UPDATE_CHECK_INTERVAL_HOURS: "6",
      }),
    ).toBe(6);
  });

  it("allows 0 to disable the schedule", () => {
    expect(
      resolveUpdateCheckIntervalHours({
        PLOTROOM_UPDATE_CHECK_INTERVAL_HOURS: "0",
      }),
    ).toBe(0);
  });

  it("rejects a negative value", () => {
    expect(() =>
      resolveUpdateCheckIntervalHours({
        PLOTROOM_UPDATE_CHECK_INTERVAL_HOURS: "-1",
      }),
    ).toThrow();
  });
});
