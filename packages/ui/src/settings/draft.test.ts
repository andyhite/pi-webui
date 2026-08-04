import { describe, expect, it } from "vitest";

import { checkDraft, draftFromValue, parseDraft } from "./draft.js";
import type { SettingRow, SettingType } from "./types.js";

function row(
  type: SettingType,
  value: unknown,
  extra: Partial<SettingRow> = {},
): SettingRow {
  return {
    key: "aSetting",
    group: "Group",
    label: "A setting",
    description: "what it does",
    type,
    envVar: null,
    sensitive: false,
    appliesWithoutRestart: true,
    value,
    defaultValue: null,
    overridden: false,
    ...extra,
  };
}

describe("the settings draft", () => {
  it("never seeds the field from a sensitive row, set or not", () => {
    expect(
      draftFromValue(row("string", "[redacted]", { sensitive: true })),
    ).toBe("");
    expect(draftFromValue(row("string", null, { sensitive: true }))).toBe("");
    // The whole point of the rule: this is also what the field holds *after*
    // a successful write, so the secret does not stay in the input.
    expect(
      draftFromValue(
        row("string", "[redacted]", { sensitive: true, overridden: true }),
      ),
    ).toBe("");
  });

  it("seeds a non-sensitive field from the row's own value", () => {
    expect(draftFromValue(row("number", 7))).toBe("7");
    expect(draftFromValue(row("boolean", false))).toBe("false");
    expect(draftFromValue(row("string[]", ["a", "b"]))).toBe("a, b");
    expect(draftFromValue(row("string", null))).toBe("");
  });

  it("refuses an empty number field rather than writing the zero Number('') is", () => {
    const reason = checkDraft(row("number", 30), "");
    expect(reason).not.toBeNull();
    expect(reason).toContain("not a zero");
    // The refusal exists because this is what the write would otherwise carry.
    expect(parseDraft(row("number", 30), "")).toBe(0);
  });

  it("refuses a number field that is not a number, and names what was typed", () => {
    expect(checkDraft(row("number", 30), "   ")).toContain("not a zero");
    expect(checkDraft(row("number", 30), "1e")).toContain('"1e" is not one');
    expect(checkDraft(row("number", 30), "-")).toContain('"-" is not one');
  });

  it("accepts a typed zero — a bound is the server's answer, not the field's", () => {
    expect(checkDraft(row("number", 30), "0")).toBeNull();
    expect(parseDraft(row("number", 30), "0")).toBe(0);
  });

  it("judges only number drafts — every other type carries what was typed", () => {
    expect(checkDraft(row("string", ""), "")).toBeNull();
    expect(checkDraft(row("string[]", []), "")).toBeNull();
    expect(parseDraft(row("string[]", []), " a , ,b ")).toEqual(["a", "b"]);
    expect(parseDraft(row("boolean", false), "true")).toBe(true);
    expect(parseDraft(row("enum", "warn"), "debug")).toBe("debug");
  });
});
