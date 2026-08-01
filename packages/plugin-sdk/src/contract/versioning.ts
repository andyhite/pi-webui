/**
 * Contract versioning (§10.2): "**refusal or warning rather than obscure
 * failure**".
 *
 * The draft had a number and a comparison; this is the rule. Three verdicts, and
 * which one applies is decided here and nowhere else, so the host, the install
 * path, and any future packaging check cannot disagree (principle 8):
 *
 * - **`ok`** — built against exactly what this host implements.
 * - **`warn`** — built against an older version this host still supports. It loads,
 *   and the warning is on the plugin's health surface, because a plugin that works
 *   and is out of date is out of date, not broken (§10.2 lists "out of date" as a
 *   health state of its own).
 * - **`refuse`** — built against a **newer** version, or one older than this host
 *   still supports. Newer is refused rather than attempted because a plugin built
 *   against a contract this host does not implement will fail somewhere obscure,
 *   which is the exact failure §10.2 rules out; too-old is refused because support
 *   was withdrawn deliberately and running it anyway would make the withdrawal
 *   documentation.
 *
 * Every verdict carries a sentence naming both numbers. "Obscure failure" is what
 * happens when the operator is told a plugin is unavailable without being told the
 * one thing that would let them fix it.
 */
import {
  CONTRACT_VERSION,
  MINIMUM_SUPPORTED_CONTRACT_VERSION,
} from "./manifest.js";

export type ContractVersionVerdict = "ok" | "warn" | "refuse";

export interface ContractVersionCheck {
  readonly verdict: ContractVersionVerdict;
  /** Shown verbatim on the plugin's health surface. Names both versions. */
  readonly reason: string;
  readonly declared: number;
  readonly host: number;
}

export interface ContractVersionRange {
  readonly host: number;
  readonly minimum: number;
}

export const HOST_CONTRACT_RANGE: ContractVersionRange = {
  host: CONTRACT_VERSION,
  minimum: MINIMUM_SUPPORTED_CONTRACT_VERSION,
};

/**
 * Decide what to do with a declared contract version.
 *
 * The range is a parameter so the rule is testable across a window that does not
 * exist yet: v1 is the first contract, so `warn` is unreachable against the real
 * constants today and would otherwise be an untested branch on the day it starts
 * mattering.
 */
export function checkContractVersion(
  declared: number,
  range: ContractVersionRange = HOST_CONTRACT_RANGE,
): ContractVersionCheck {
  const base = { declared, host: range.host } as const;
  if (!Number.isInteger(declared) || declared < 1) {
    return {
      ...base,
      verdict: "refuse",
      reason: `contractVersion must be a positive integer; this plugin declares ${String(declared)}`,
    };
  }
  if (declared > range.host) {
    return {
      ...base,
      verdict: "refuse",
      reason: `built against plugin contract v${declared}; this PlotRoom implements v${range.host}. Update PlotRoom, or install a build of the plugin for v${range.host}.`,
    };
  }
  if (declared < range.minimum) {
    return {
      ...base,
      verdict: "refuse",
      reason: `built against plugin contract v${declared}; this PlotRoom supports v${range.minimum} and newer. Update the plugin.`,
    };
  }
  if (declared < range.host) {
    return {
      ...base,
      verdict: "warn",
      reason: `built against plugin contract v${declared}; this PlotRoom implements v${range.host}. It still loads — the plugin is out of date, not broken.`,
    };
  }
  return {
    ...base,
    verdict: "ok",
    reason: `built against plugin contract v${declared}`,
  };
}
