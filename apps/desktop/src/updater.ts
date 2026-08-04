/**
 * Update checks (spec §12, AGENTS.md's electron-builder/electron-updater
 * decision) — wired so a check is a scheduled **read** (principle 2's
 * exception) and an install is never performed with nobody behind it.
 *
 * Three gestures, three different amounts of consent:
 *
 *   - **check**: always allowed, on launch and on a configurable interval
 *     (same "0 disables the schedule, the on-demand path still works"
 *     convention `apps/server`'s compaction/attention/integration ticks
 *     use) — a check alone spends nothing and changes nothing.
 *   - **download**: an update found asks the operator via a native dialog
 *     before downloading, unless `autoInstallUpdates` is set, in which case
 *     the operator already gave standing consent for this exact class of
 *     "no one is watching" action.
 *   - **install**: always asks again after the download finishes ("restart
 *     now?"), unless `autoInstallOnQuit` is separately true — kept
 *     `false` here always, deliberately: `autoInstallUpdates` covers
 *     *download*, and installing on quit besides is a second, stronger
 *     claim this batch does not make on the operator's behalf.
 *
 * `AutoUpdaterLike` is the subset of `electron-updater`'s `autoUpdater`
 * this module actually calls, so the decision logic is unit-testable
 * against a fake rather than the real singleton (which reaches for
 * `app.getVersion()`/network at import time).
 */

export interface UpdateInfoLike {
  readonly version: string;
}

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "update-available", listener: (info: UpdateInfoLike) => void): void;
  on(
    event: "update-downloaded",
    listener: (info: UpdateInfoLike) => void,
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface UpdatePrompter {
  /** Resolves `true` if the operator wants the update downloaded now. */
  confirmDownload(info: UpdateInfoLike): Promise<boolean>;
  /** Resolves `true` if the operator wants to restart and install now. */
  confirmInstall(info: UpdateInfoLike): Promise<boolean>;
  notifyError(error: Error): void;
}

export interface ConfigureUpdaterInput {
  readonly autoUpdater: AutoUpdaterLike;
  readonly prompter: UpdatePrompter;
  readonly autoInstallUpdates: boolean;
  readonly logger?: { warn: (msg: string) => void };
}

/**
 * Wires the operator-consent rules onto an `autoUpdater`-shaped object.
 * Idempotent to call more than once is not guaranteed — call it exactly
 * once, at startup, the same convention as the rest of `main.ts`'s wiring.
 */
export function configureUpdater(input: ConfigureUpdaterInput): void {
  const { autoUpdater, prompter, autoInstallUpdates } = input;

  // Never silent by default (principle 2): a found update does not download
  // itself until either the operator says yes to *this* prompt or the
  // operator already flipped the standing setting.
  autoUpdater.autoDownload = autoInstallUpdates;
  // Installing on quit is never automatic from this module — see the
  // doc comment above.
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", (info) => {
    if (autoInstallUpdates) return; // already downloading; nothing to ask.
    void prompter.confirmDownload(info).then((confirmed) => {
      if (confirmed) void autoUpdater.downloadUpdate();
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    void prompter.confirmInstall(info).then((confirmed) => {
      if (confirmed) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on("error", (error) => {
    // A missing/unreachable update feed (no publish target decided yet, or
    // simply offline) is not a crash — the operator did not ask for
    // anything to happen, so nothing failing to happen is not a failure.
    input.logger?.warn(`update check failed: ${error.message}`);
    prompter.notifyError(error);
  });
}

/** A single check — the scheduled-read half, safe to call on a timer. */
export async function checkForUpdatesNow(
  autoUpdater: AutoUpdaterLike,
  logger?: { warn: (msg: string) => void },
): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    logger?.warn(
      `update check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * `0` disables the schedule, same convention as
 * `PLOTROOM_COMPACTION_INTERVAL_SECONDS` et al. — the on-demand check
 * (menu item) still works regardless.
 */
export function resolveUpdateCheckIntervalHours(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.PLOTROOM_UPDATE_CHECK_INTERVAL_HOURS;
  if (raw === undefined) return 24;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `PLOTROOM_UPDATE_CHECK_INTERVAL_HOURS must be a non-negative number, got ${raw}`,
    );
  }
  return parsed;
}
