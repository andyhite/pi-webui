import type { Author, SettingChange } from "@plotroom/core";
import type { SettingsStore } from "@plotroom/db";
import type { ServerConfig } from "../config.js";
import type { EventBus } from "../events/bus.js";
import { badRequest, notFound } from "../http/errors.js";
import {
  checkSettingValue,
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
  /**
   * Stored overrides boot **refused to apply**, keyed by setting key, with the
   * reason (`applyStoredSettings`'s own answer). Passed in rather than
   * re-derived, because only boot knows what it actually ran under: a read that
   * reported a stored value this process ignored would be the surface lying
   * about itself, which is the whole reason the skip is reported at all.
   */
  readonly ignored?: Readonly<Record<string, string>>;
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
  /**
   * `"[redacted]"` for a sensitive setting that has a value set, `null` only
   * when it genuinely has none — never the real value (§9.3's rule, applied
   * here).
   */
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly overridden: boolean;
  /**
   * Why the stored override for this key is **not** in effect, when boot
   * refused it. `value` then reports what the process is actually running
   * under, not the row — and this sentence is what makes that honest rather
   * than merely quiet.
   */
  readonly ignoredReason?: string;
}

export class SettingsService {
  /** Boot's refusals, cleared per key the moment a legal value replaces one. */
  readonly #ignored: Map<string, string>;

  constructor(private readonly deps: SettingsServiceDeps) {
    this.#ignored = new Map(Object.entries(deps.ignored ?? {}));
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
    // The same judgement boot applies to a value it reads back
    // (`checkSettingValue`), so this surface cannot store what a boot would
    // refuse to run under.
    const wrong = checkSettingValue(entry, rawValue);
    if (wrong !== null) throw badRequest(`"${entry.key}" must be ${wrong}`);
    const value = rawValue;

    // Written first, then the ignore cleared: if the write itself fails, the
    // earlier refusal is still the truth about what this process is running
    // under, and a read must not start reporting the bad row as being in effect.
    this.deps.store.set(key, JSON.stringify(value));
    this.#ignored.delete(key);
    this.deps.liveAppliers[key]?.(value);
    this.publish(entry, actor);

    return this.reportFor(entry);
  }

  /** Reverts to the env-derived default — an absence, not a third state. */
  remove(key: string, actor: Author): SettingReport {
    const entry = this.require(key);

    this.#ignored.delete(key);
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
    const ignoredReason = this.#ignored.get(entry.key);
    // A stored value boot refused is not an override in effect, so it is not
    // reported as one: `value` is what this process is running under and
    // `ignoredReason` says why the row is not it.
    const overridden = row !== undefined && ignoredReason === undefined;
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
      ...(ignoredReason === undefined ? {} : { ignoredReason }),
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
