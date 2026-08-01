/**
 * Plugin lifecycle without restarting the product (§10.2).
 *
 * "Install, enable, disable, remove — per plugin, without restarting. Plugin health
 * is a first-class surface: connected, misconfigured, failing, out of date."
 *
 * The registry is the state machine and nothing else: it owns which plugins exist,
 * which are enabled, and one {@link PluginHost} per enabled plugin. It decides
 * nothing about permissions (the host does), nothing about the contract (the
 * contract does), and it publishes rather than renders — the server turns
 * {@link PluginRegistryEvent} into WebSocket events and the health surface reads
 * {@link PluginRegistry.list}.
 *
 * ## The four verbs, and why each is a real state
 *
 * - **install** reads the manifest in a throwaway worker and records what the
 *   plugin *is*. It does not run it: a plugin the operator has not enabled must not
 *   be reachable, and "installed" is therefore a state rather than a synonym for
 *   disabled-with-a-worker.
 * - **enable** starts the worker. Failure is not an exception — an enabled plugin
 *   that cannot load is `enabled` with unavailable health, which is exactly §10.2's
 *   "reported, never a product that won't start".
 * - **disable** disposes the worker and keeps the record, so re-enabling costs no
 *   rediscovery.
 * - **remove** disposes and forgets. It deletes no files: the plugin came from a
 *   directory the operator owns, and a product that deleted from it would be
 *   destroying authored state without asking (principle 10, §6.6).
 *
 * ## Distribution, stated honestly (§10.2)
 *
 * v1 covers **in the box** (entries the app ships) and **from a directory** (a
 * configured plugins directory, scanned on demand — never on a timer, principle 2).
 * **From a source the user configures** — a registry or URL a plugin is fetched
 * from — is *deferred*: it needs a fetch, a verification story, and an update path
 * that must not silently widen permissions, none of which Epic 7.1 decided.
 * `docs/plugin-contract.md` records that deferral rather than implying coverage.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { PluginDescriptor } from "./contract/manifest.js";
import type { PermissionGrant } from "./contract/permissions.js";
import type { PluginId } from "./contract/ids.js";
import type { PluginHealth, PluginHostOptions } from "./host.js";
import { PluginHost } from "./host.js";

/** Where a plugin came from (§10.2). */
export const PLUGIN_ORIGINS = ["in-box", "directory"] as const;

export type PluginOrigin = (typeof PLUGIN_ORIGINS)[number];

/**
 * The lifecycle states. `installed` and `disabled` are distinct on purpose: one has
 * never been enabled, the other was turned off, and an operator looking at a plugin
 * list wants to know which.
 */
export const PLUGIN_STATES = ["installed", "enabled", "disabled"] as const;

export type PluginState = (typeof PLUGIN_STATES)[number];

export interface PluginRecord {
  readonly id: PluginId;
  readonly entry: string;
  readonly origin: PluginOrigin;
  readonly state: PluginState;
  readonly descriptor: PluginDescriptor;
  /** Null while disabled: health is a running plugin's property (§10.2). */
  readonly health: PluginHealth | null;
  readonly installedAt: number;
}

/** What the server publishes on its one event stream when a plugin's state moves. */
export interface PluginRegistryEvent {
  readonly type: "plugin";
  readonly pluginId: PluginId;
  readonly state: PluginState;
  readonly health: PluginHealth | null;
  readonly at: number;
}

export interface PluginRegistryOptions {
  /** Applied to every host; per-plugin grants are supplied by `grantsFor`. */
  readonly host?: Omit<PluginHostOptions, "grants" | "onHealth">;
  /** The operator's answers, per plugin (§10.2). Absent means never-asked. */
  readonly grantsFor?: (pluginId: PluginId) => readonly PermissionGrant[];
  readonly onEvent?: (event: PluginRegistryEvent) => void;
  /** Injectable, like every clock in this codebase. */
  readonly now?: () => number;
}

export class PluginNotInstalledError extends Error {
  constructor(pluginId: PluginId) {
    super(`no plugin named ${pluginId} is installed`);
    this.name = "PluginNotInstalledError";
  }
}

/** A plugin that could not even be read; recorded, never thrown past the operator. */
export interface PluginInstallFailure {
  readonly entry: string;
  readonly origin: PluginOrigin;
  readonly reason: string;
}

export type InstallResult =
  | { readonly installed: true; readonly record: PluginRecord }
  | { readonly installed: false; readonly failure: PluginInstallFailure };

export class PluginRegistry {
  readonly #records = new Map<PluginId, PluginRecord>();
  readonly #hosts = new Map<PluginId, PluginHost>();
  readonly #options: PluginRegistryOptions;
  readonly #now: () => number;

  constructor(options: PluginRegistryOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
  }

  list(): readonly PluginRecord[] {
    return [...this.#records.values()];
  }

  get(pluginId: PluginId): PluginRecord | null {
    return this.#records.get(pluginId) ?? null;
  }

  /** The running host, for invocation. Null unless the plugin is enabled. */
  host(pluginId: PluginId): PluginHost | null {
    return this.#hosts.get(pluginId) ?? null;
  }

  /**
   * Read a plugin's manifest and record it, without running it afterwards.
   *
   * A manifest that cannot be read is an install failure with a reason — the same
   * reason the health surface would have shown — rather than a throw.
   */
  async install(
    entry: string | URL,
    origin: PluginOrigin = "directory",
  ): Promise<InstallResult> {
    const host = await PluginHost.load(
      entry,
      this.#hostOptions("(installing)"),
    );
    const descriptor = host.descriptor;
    const health = host.health;
    await host.dispose();
    if (descriptor === null) {
      return {
        installed: false,
        failure: {
          entry: String(entry),
          origin,
          reason:
            health.status === "unavailable"
              ? health.reason
              : "plugin did not load",
        },
      };
    }
    const record: PluginRecord = {
      id: descriptor.id,
      entry: String(entry),
      origin,
      state: "installed",
      descriptor,
      health: null,
      installedAt: this.#now(),
    };
    this.#put(record);
    return { installed: true, record };
  }

  /** Start the plugin's worker. Never throws for a plugin that fails to load. */
  async enable(pluginId: PluginId): Promise<PluginRecord> {
    const record = this.#require(pluginId);
    const existing = this.#hosts.get(pluginId);
    if (existing !== undefined) {
      return record;
    }
    // Enabling is the operator's act and takes effect at once; health is what
    // the plugin then reports, and it arrives on its own event (§10.2).
    this.#put({ ...record, state: "enabled", health: { status: "loading" } });
    const host = await PluginHost.load(
      record.entry,
      this.#hostOptions(pluginId),
    );
    this.#hosts.set(pluginId, host);
    return this.#require(pluginId);
  }

  /** Stop the plugin's worker and keep the record. */
  async disable(pluginId: PluginId): Promise<PluginRecord> {
    const record = this.#require(pluginId);
    const host = this.#hosts.get(pluginId);
    this.#hosts.delete(pluginId);
    await host?.dispose();
    return this.#put({ ...record, state: "disabled", health: null });
  }

  /** Stop and forget. Deletes nothing on disk — the directory is the operator's. */
  async remove(pluginId: PluginId): Promise<void> {
    const record = this.#records.get(pluginId);
    if (record === undefined) {
      return;
    }
    const host = this.#hosts.get(pluginId);
    this.#hosts.delete(pluginId);
    await host?.dispose();
    this.#records.delete(pluginId);
    this.#options.onEvent?.({
      type: "plugin",
      pluginId,
      state: "disabled",
      health: null,
      at: this.#now(),
    });
  }

  /**
   * Install everything discoverable in a configured plugins directory (§10.2).
   *
   * A scan is a **read the operator asked for**, never a schedule (principle 2),
   * and an unreadable candidate is reported rather than dropped (principle 12).
   */
  async installFromDirectory(directory: string): Promise<{
    readonly installed: readonly PluginRecord[];
    readonly failures: readonly PluginInstallFailure[];
  }> {
    const discovered = await discoverPluginEntries(directory);
    const installed: PluginRecord[] = [];
    const failures: PluginInstallFailure[] = [
      ...discovered.unreadable.map((entry) => ({
        entry,
        origin: "directory" as const,
        reason:
          "no plugin entry file (index.js, index.mjs, plugin.js or index.ts)",
      })),
    ];
    for (const entry of discovered.entries) {
      const result = await this.install(entry, "directory");
      if (result.installed) {
        installed.push(result.record);
      } else {
        failures.push(result.failure);
      }
    }
    return { installed, failures };
  }

  /** Dispose every running plugin. Idempotent. */
  async disposeAll(): Promise<void> {
    const hosts = [...this.#hosts.values()];
    this.#hosts.clear();
    await Promise.all(hosts.map((host) => host.dispose()));
  }

  #hostOptions(pluginId: PluginId): PluginHostOptions {
    const grants = this.#options.grantsFor?.(pluginId) ?? [];
    return {
      ...this.#options.host,
      grants,
      onHealth: (health): void => {
        const record = this.#records.get(pluginId);
        if (record === undefined) {
          return;
        }
        this.#put({ ...record, health });
      },
    };
  }

  #put(record: PluginRecord): PluginRecord {
    this.#records.set(record.id, record);
    this.#options.onEvent?.({
      type: "plugin",
      pluginId: record.id,
      state: record.state,
      health: record.health,
      at: this.#now(),
    });
    return record;
  }

  #require(pluginId: PluginId): PluginRecord {
    const record = this.#records.get(pluginId);
    if (record === undefined) {
      throw new PluginNotInstalledError(pluginId);
    }
    return record;
  }
}

/** Entry files a directory-distributed plugin may use, in the order they are tried. */
export const PLUGIN_ENTRY_FILES = [
  "index.js",
  "index.mjs",
  "plugin.js",
  "index.ts",
] as const;

/**
 * What a plugins directory contains: one subdirectory per plugin.
 *
 * The plugin's id comes from its **manifest**, never from its directory name — a
 * name on disk the operator can rename is not identity.
 */
export async function discoverPluginEntries(directory: string): Promise<{
  readonly entries: readonly string[];
  /** Subdirectories with no recognizable entry file, reported rather than dropped. */
  readonly unreadable: readonly string[];
}> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return { entries: [], unreadable: [] };
  }
  const entries: string[] = [];
  const unreadable: string[] = [];
  for (const name of names.sort()) {
    const candidateDir = join(directory, name);
    const stats = await stat(candidateDir).catch(() => null);
    if (stats === null || !stats.isDirectory()) {
      continue;
    }
    const entry = await firstExisting(candidateDir);
    if (entry === null) {
      unreadable.push(candidateDir);
      continue;
    }
    entries.push(pathToFileURL(entry).href);
  }
  return { entries, unreadable };
}

async function firstExisting(directory: string): Promise<string | null> {
  for (const file of PLUGIN_ENTRY_FILES) {
    const candidate = join(directory, file);
    const stats = await stat(candidate).catch(() => null);
    if (stats !== null && stats.isFile()) {
      return candidate;
    }
  }
  return null;
}
