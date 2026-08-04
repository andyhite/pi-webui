import { describe, expect, it } from "vitest";
import {
  CONCURRENCY_LIMIT_BOUND,
  INTERVAL_SECONDS_BOUND,
  loadServerConfig,
  outsideBound,
} from "../config.js";
import { SETTINGS_CATALOG } from "./catalog.js";

/**
 * One statement of what a configurable number has to be (#69).
 *
 * The bug this pins: `PLOTROOM_CONCURRENCY_LIMIT=0` was refused at boot, and a
 * `PUT /api/settings/concurrencyLimit {value: 0}` was accepted — so the same
 * number had two rules, and the looser path stored a value that refused every
 * admission for ever. The rule is now `NumericBound`, and these tests are about
 * the two paths agreeing rather than about either one's mechanics.
 */

describe("outsideBound", () => {
  it("admits the bound's own minimum, because a bound is inclusive", () => {
    expect(outsideBound(CONCURRENCY_LIMIT_BOUND, 1)).toBeNull();
    expect(outsideBound(INTERVAL_SECONDS_BOUND, 0)).toBeNull();
  });

  it("refuses below the minimum, and says the requirement rather than the number", () => {
    expect(outsideBound(CONCURRENCY_LIMIT_BOUND, 0)).toBe(
      CONCURRENCY_LIMIT_BOUND.requirement,
    );
    expect(outsideBound(INTERVAL_SECONDS_BOUND, -1)).toBe(
      INTERVAL_SECONDS_BOUND.requirement,
    );
  });

  it("refuses a fraction only where the bound asks for whole numbers", () => {
    // Half a session is not a limit; half a second is a legal interval.
    expect(outsideBound(CONCURRENCY_LIMIT_BOUND, 2.5)).not.toBeNull();
    expect(outsideBound(INTERVAL_SECONDS_BOUND, 2.5)).toBeNull();
  });

  it("refuses what is not a number at all, whichever bound is asked", () => {
    for (const bound of [CONCURRENCY_LIMIT_BOUND, INTERVAL_SECONDS_BOUND]) {
      expect(outsideBound(bound, Number.NaN)).not.toBeNull();
      expect(outsideBound(bound, Number.POSITIVE_INFINITY)).not.toBeNull();
    }
  });
});

describe("the catalog's bound and the environment parser are one rule", () => {
  const bounded = SETTINGS_CATALOG.filter((entry) => entry.bound !== undefined);

  it("covers every numeric setting, so none is bounded on one path only", () => {
    const unbounded = SETTINGS_CATALOG.filter(
      (entry) => entry.type === "number" && entry.bound === undefined,
    ).map((entry) => entry.key);

    // `port` is deliberately the exception: its environment variable has no
    // rule to mirror either (see the follow-up), so a bound here would make the
    // settings path stricter than the boot path — the same disagreement, the
    // other way round.
    expect(unbounded).toEqual(["port"]);
  });

  it("refuses at boot exactly what the catalog's bound refuses", () => {
    expect(bounded.length).toBeGreaterThan(0);

    for (const entry of bounded) {
      expect(entry.envVar, entry.key).not.toBeNull();
      const refused = entry.bound!.min - 1;
      expect(outsideBound(entry.bound!, refused), entry.key).not.toBeNull();

      // The environment path must refuse the same value the settings route
      // does. If a future bound is loosened in only one place, this fails.
      expect(
        () =>
          loadServerConfig({ [entry.envVar as string]: String(refused) }, {}),
        entry.key,
      ).toThrow(new RegExp(entry.bound!.requirement.split(",")[0]!));
    }
  });

  it("accepts at boot exactly what the catalog's bound accepts", () => {
    for (const entry of bounded) {
      const allowed = String(entry.bound!.min);
      expect(() =>
        loadServerConfig({ [entry.envVar as string]: allowed }, {}),
      ).not.toThrow();
    }
  });
});
