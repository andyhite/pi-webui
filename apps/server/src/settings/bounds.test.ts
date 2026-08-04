import { describe, expect, it } from "vitest";
import {
  checkBound,
  CONCURRENCY_LIMIT_BOUND,
  INTERVAL_SECONDS_BOUND,
  loadServerConfig,
  PORT_BOUND,
} from "../config.js";
import { checkSettingValue, readPath, SETTINGS_CATALOG } from "./catalog.js";

/**
 * One statement of what a configurable number has to be (#69).
 *
 * The bug this pins: `PLOTROOM_CONCURRENCY_LIMIT=0` was refused at boot, and a
 * `PUT /api/settings/concurrencyLimit {value: 0}` was accepted — so the same
 * number had two rules, and the looser path stored a value that refused every
 * admission for ever. The rule is now `NumericBound`, and these tests are about
 * the two paths agreeing rather than about either one's mechanics.
 */

describe("checkBound", () => {
  it("admits the bound's own minimum and maximum, because a bound is inclusive", () => {
    expect(checkBound(CONCURRENCY_LIMIT_BOUND, 1)).toBeNull();
    expect(checkBound(INTERVAL_SECONDS_BOUND, 0)).toBeNull();
    expect(checkBound(INTERVAL_SECONDS_BOUND, 2_147_483)).toBeNull();
    expect(checkBound(PORT_BOUND, 0)).toBeNull();
    expect(checkBound(PORT_BOUND, 65_535)).toBeNull();
  });

  it("refuses below the minimum, and says the requirement rather than the number", () => {
    expect(checkBound(CONCURRENCY_LIMIT_BOUND, 0)).toBe(
      CONCURRENCY_LIMIT_BOUND.requirement,
    );
    expect(checkBound(INTERVAL_SECONDS_BOUND, -1)).toBe(
      INTERVAL_SECONDS_BOUND.requirement,
    );
    expect(checkBound(PORT_BOUND, -5)).toBe(PORT_BOUND.requirement);
  });

  it("refuses above the maximum where one exists, and nowhere else", () => {
    // An interval past 2^31-1 ms is clamped by `setInterval` to 1 ms, so a
    // number meant as "practically never" would run the job constantly.
    expect(checkBound(INTERVAL_SECONDS_BOUND, 2_147_484)).not.toBeNull();
    expect(checkBound(PORT_BOUND, 65_536)).not.toBeNull();
    // The concurrency limit deliberately has no ceiling: "a limit of none is
    // spelled by setting it high".
    expect(CONCURRENCY_LIMIT_BOUND.max).toBeUndefined();
    expect(checkBound(CONCURRENCY_LIMIT_BOUND, 1_000_000)).toBeNull();
  });

  it("refuses a fraction only where the bound asks for whole numbers", () => {
    // Half a session is not a limit; half a second is a legal interval.
    expect(checkBound(CONCURRENCY_LIMIT_BOUND, 2.5)).not.toBeNull();
    expect(checkBound(PORT_BOUND, 80.5)).not.toBeNull();
    expect(checkBound(INTERVAL_SECONDS_BOUND, 2.5)).toBeNull();
  });

  it("refuses what is not a number at all, whichever bound is asked", () => {
    for (const bound of [
      CONCURRENCY_LIMIT_BOUND,
      INTERVAL_SECONDS_BOUND,
      PORT_BOUND,
    ]) {
      expect(checkBound(bound, Number.NaN)).not.toBeNull();
      expect(checkBound(bound, Number.POSITIVE_INFINITY)).not.toBeNull();
    }
  });
});

describe("the catalog's bound and the environment parser are one rule", () => {
  const numeric = SETTINGS_CATALOG.filter((entry) => entry.type === "number");

  it("bounds every numeric setting, so none is checked on one path only", () => {
    const unbounded = numeric
      .filter((entry) => entry.bound === undefined)
      .map((entry) => entry.key)
      .sort();

    // Not a style rule: a numeric setting bounded on the write path alone is how
    // #69 happened, and one bounded nowhere is how a stored port made the
    // product unbootable.
    expect(unbounded).toEqual([]);
  });

  it("refuses at boot exactly what the catalog's bound refuses", () => {
    expect(numeric.length).toBeGreaterThan(0);

    for (const entry of numeric) {
      const bound = entry.bound;
      if (bound === undefined) throw new Error(`${entry.key} has no bound`);
      expect(entry.envVar, entry.key).not.toBeNull();

      const refused = bound.min - 1;
      expect(checkBound(bound, refused), entry.key).not.toBeNull();
      expect(checkSettingValue(entry, refused), entry.key).not.toBeNull();

      // The environment path must refuse the same value the settings route
      // does. If a future bound is loosened in only one place, this fails.
      expect(
        () => loadServerConfig({ [String(entry.envVar)]: String(refused) }, {}),
        entry.key,
      ).toThrow(bound.requirement);
    }
  });

  it("accepts at boot exactly what the catalog's bound accepts, and keeps the value", () => {
    for (const entry of numeric) {
      const bound = entry.bound;
      if (bound === undefined) throw new Error(`${entry.key} has no bound`);

      const allowed = bound.min;
      expect(checkSettingValue(entry, allowed), entry.key).toBeNull();

      // Parsed *and* kept: a parser that validated and then discarded the value
      // would pass a "does not throw" assertion.
      const config = loadServerConfig(
        { [String(entry.envVar)]: String(allowed) },
        {},
      );
      expect(readPath(config, entry.path), entry.key).toBe(allowed);
    }
  });
});

describe("checkSettingValue is the one judgement of a stored or written value", () => {
  it("refuses a value of the wrong type, which no bound would have caught", () => {
    const limit = SETTINGS_CATALOG.find(
      (entry) => entry.key === "concurrencyLimit",
    );
    if (limit === undefined) throw new Error("concurrencyLimit is missing");

    // The other door into #69's wedge: a stored string reached the queue as its
    // limit, and `running < "abc"` is false for ever.
    for (const value of ["abc", null, true, {}]) {
      expect(checkSettingValue(limit, value), String(value)).not.toBeNull();
    }
    expect(checkSettingValue(limit, 4)).toBeNull();
  });

  it("still treats null as a value for a string setting, never as a type error", () => {
    const credential = SETTINGS_CATALOG.find(
      (entry) => entry.key === "credential",
    );
    if (credential === undefined) throw new Error("credential is missing");

    // "Not set" is a legal state for the credential, distinct from a wrong type.
    expect(checkSettingValue(credential, null)).toBeNull();
    expect(checkSettingValue(credential, 7)).not.toBeNull();
  });
});
