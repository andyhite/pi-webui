import type { Author, SettingChange } from "@plotroom/core";
import type { SettingsStore } from "@plotroom/db";
import type { ServerConfig } from "../config.js";
import type { EventBus } from "../events/bus.js";
import { badRequest, notFound } from "../http/errors.js";
import {
  findSetting,
  readPath,
  SETTINGS_CATALOG,
  type SettingDefinition,
  type SettingType,
} from "./catalog.js";

/**
 * Settings, at the seam Epic 2.1 deliberately left open: `loadServerConfig`
 * takes explicit overrides "so the eventual settings store has a seam to call
 * into instead of env directly" — this is that store's caller.
 *
 * Two things are load-bearing:
 *
 * 1. **The catalog's claim and the mechanism must agree.** `appliesWithoutRestart`
 *    is asserted against `liveAppliers` at construction, not merely documented
 *    (cross-cutting rule 3) — a setting the catalog calls live with no applier
 *    wired, or an applier wired for a setting the catalog calls restart-only,
 *    is a programming error caught at boot rather than a surface quietly lying
 *    to the operator about what a write just did.
 * 2. **A write always answers with what actually happened**: the persisted
 *    value, whether it took effect, and — when it did not — why, verbatim from
 *    the catalog, never re-derived at the route.
 */
export interface SettingsServiceDeps {
  readonly store: SettingsStore;
  readonly bus: EventBus;
  /**
   * The env-derived defaults — what this process would run with if no
   * setting had ever been overridden. Computed once, from `process.env`
   * alone, so "remove this override" has something honest to revert to.
   */
  readonly defaults: ServerConfig;
  /**
   * One function per setting whose `appliesWithoutRestart` is `true`, keyed by
   * catalog key. Removing an override calls the applier with the default's own
   * value, which is what makes "revert" and "apply the default live" the same
   * code path rather than two.
   */
  readonly liveAppliers: Readonly<Record<string, (value: unknown) => void>>;
}

export interface SettingReport {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly type: SettingType;
  readonly enumValues?: readonly string[];
  readonly envVar: string | null;
  readonly sensitive: boolean;
  readonly appliesWithoutRestart: boolean;
  readonly restartReason?: string;
  /** A session may not read or write this setting (principle 1); enforced by the route. */
  readonly humanOnly: boolean;
  /** `null` for a sensitive setting with a value set — never echoed (§9.3's rule, applied here). */
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly overridden: boolean;
}

export class SettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {
    for (const entry of SETTINGS_CATALOG) {
      const hasApplier = entry.key in deps.liveAppliers;
      if (entry.appliesWithoutRestart !== hasApplier) {
        throw new Error(
          `settings catalog/mechanism mismatch for "${entry.key}": ` +
            `catalog says appliesWithoutRestart=${entry.appliesWithoutRestart} ` +
            `but a live applier ${hasApplier ? "exists" : "is missing"}`,
        );
      }
    }
  }

  list(): SettingReport[] {
    return SETTINGS_CATALOG.map((entry) => this.reportFor(entry));
  }

  /** Grouped and searchable over the label/description/group (§11). */
  search(query: string): SettingReport[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return this.list();
    return this.list().filter(
      (report) =>
        report.key.toLowerCase().includes(needle) ||
        report.label.toLowerCase().includes(needle) ||
        report.description.toLowerCase().includes(needle) ||
        report.group.toLowerCase().includes(needle),
    );
  }

  get(key: string): SettingReport {
    return this.reportFor(this.require(key));
  }

  set(key: string, rawValue: unknown, actor: Author): SettingReport {
    const entry = this.require(key);
    const value = validateValue(entry, rawValue);

    this.deps.store.set(key, JSON.stringify(value));
    this.deps.liveAppliers[key]?.(value);
    this.publish(entry, actor);

    return this.reportFor(entry);
  }

  /** Reverts to the env-derived default — an absence, not a third state. */
  remove(key: string, actor: Author): SettingReport {
    const entry = this.require(key);

    this.deps.store.remove(key);
    const fallback = readPath(this.deps.defaults, entry.path);
    this.deps.liveAppliers[key]?.(fallback);
    this.publish(entry, actor);

    return this.reportFor(entry);
  }

  private require(key: string): SettingDefinition {
    const entry = findSetting(key);
    if (!entry) throw notFound(`unknown setting ${key}`);
    return entry;
  }

  private reportFor(entry: SettingDefinition): SettingReport {
    const row = this.deps.store.get(entry.key);
    const overridden = row !== undefined;
    const defaultValue = readPath(this.deps.defaults, entry.path);
    const value = overridden
      ? (JSON.parse(row.valueJson) as unknown)
      : defaultValue;

    return {
      key: entry.key,
      group: entry.group,
      label: entry.label,
      description: entry.description,
      type: entry.type,
      ...(entry.enumValues ? { enumValues: entry.enumValues } : {}),
      envVar: entry.envVar,
      sensitive: entry.sensitive ?? false,
      appliesWithoutRestart: entry.appliesWithoutRestart,
      ...(entry.restartReason ? { restartReason: entry.restartReason } : {}),
      humanOnly: entry.humanOnly,
      // Never echoed, on the wire any more than in a read (§9.3's rule for
      // integration credentials, applied here for the same reason): a
      // sensitive setting reports only whether it is set.
      value: entry.sensitive ? (value === null ? null : "[redacted]") : value,
      defaultValue: entry.sensitive
        ? defaultValue === null
          ? null
          : "[redacted]"
        : defaultValue,
      overridden,
    };
  }

  private publish(entry: SettingDefinition, actor: Author): void {
    const report = this.reportFor(entry);
    const setting: SettingChange = {
      key: report.key,
      value: report.value,
      overridden: report.overridden,
      appliesWithoutRestart: report.appliesWithoutRestart,
    };
    this.deps.bus.publish({
      entity: "setting",
      verb: "updated",
      setting,
      author: actor,
    });
  }
}

/** Type-checks a raw write against the catalog's declared shape (§11). */
function validateValue(entry: SettingDefinition, raw: unknown): unknown {
  switch (entry.type) {
    case "string": {
      if (raw === null) return null;
      if (typeof raw !== "string") {
        throw badRequest(`"${entry.key}" must be a string or null`);
      }
      return raw;
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw badRequest(`"${entry.key}" must be a finite number`);
      }
      return raw;
    }
    case "boolean": {
      if (typeof raw !== "boolean") {
        throw badRequest(`"${entry.key}" must be a boolean`);
      }
      return raw;
    }
    case "enum": {
      if (typeof raw !== "string" || !entry.enumValues?.includes(raw)) {
        throw badRequest(
          `"${entry.key}" must be one of: ${(entry.enumValues ?? []).join(", ")}`,
        );
      }
      return raw;
    }
    case "string[]": {
      if (
        !Array.isArray(raw) ||
        !raw.every((item): item is string => typeof item === "string")
      ) {
        throw badRequest(`"${entry.key}" must be an array of strings`);
      }
      return raw;
    }
  }
}
