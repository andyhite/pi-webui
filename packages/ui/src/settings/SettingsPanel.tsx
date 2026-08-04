/**
 * The Settings panel (§11): "grouped, searchable, applied without restart.
 * Everything configurable is a setting; environment variables only supply
 * defaults." Two verbs, matching the API's own shape rather than folding
 * them into one: **save** writes a new value (`PUT`), **remove override**
 * reverts to the catalog default (`DELETE`) — never a save with an empty
 * value standing in for "unset".
 *
 * Honesty, not optimism: `appliesWithoutRestart`/`restartReason` render
 * exactly what the catalog asserts — a restart-required setting always
 * says so, never "applied" for a write this process cannot actually pick up
 * until its next start. A sensitive setting's current value renders the
 * server's own redaction (`"[redacted]"` or "not set"); writing a new one is
 * a plain, unprefilled input — the real value is never echoed back into it.
 *
 * A grouped, searchable list (plain buttons, keyboard-reachable by Tab like
 * `GraphWarningsPanel`) rather than a combobox: unlike Search there is no
 * single flat ranked result list to highlight, so no new key binding is
 * needed here at all.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useState } from "react";

import { LiveRegion } from "../keyboard/LiveRegion.js";
import type { SettingRow, SettingsDataSource } from "./types.js";

export interface SettingsPanelProps {
  readonly dataSource: SettingsDataSource;
}

/** Preserves the catalog's own group order — first row of a group wins its position. */
function groupRows(
  rows: readonly SettingRow[],
): readonly { readonly group: string; readonly rows: readonly SettingRow[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, SettingRow[]>();
  for (const row of rows) {
    if (!byGroup.has(row.group)) {
      order.push(row.group);
      byGroup.set(row.group, []);
    }
    byGroup.get(row.group)?.push(row);
  }
  return order.map((group) => ({ group, rows: byGroup.get(group) ?? [] }));
}

function draftFromValue(row: SettingRow): string {
  if (row.sensitive) return "";
  if (row.type === "string[]") {
    return Array.isArray(row.value) ? row.value.join(", ") : "";
  }
  if (row.value === null || row.value === undefined) return "";
  return String(row.value);
}

function parseDraft(row: SettingRow, draft: string): unknown {
  switch (row.type) {
    case "boolean":
      return draft === "true";
    case "number":
      return Number(draft);
    case "string[]":
      return draft
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    default:
      return draft;
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SettingsPanel({ dataSource }: SettingsPanelProps) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<readonly SettingRow[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh(q: string): void {
    void dataSource.list(q || undefined).then(setRows);
  }

  useEffect(() => {
    refresh(query);
  }, [query, dataSource]);

  useEffect(() => {
    return dataSource.subscribe(() => refresh(query));
  }, [dataSource]);

  const selected = rows.find((row) => row.key === selectedKey) ?? null;

  function select(row: SettingRow): void {
    setSelectedKey(row.key);
    setDraft(draftFromValue(row));
    setError(null);
  }

  function save(): void {
    if (!selected) return;
    setError(null);
    void dataSource
      .set(selected.key, parseDraft(selected, draft))
      .then((updated) => {
        setAnnouncement(
          updated.appliesWithoutRestart
            ? `saved ${updated.key}, applied without a restart`
            : `saved ${updated.key} — restart required: ${updated.restartReason ?? "takes effect on the next start"}`,
        );
        refresh(query);
      })
      .catch((err: unknown) => setError(messageFor(err)));
  }

  function removeOverride(): void {
    if (!selected) return;
    setError(null);
    void dataSource
      .remove(selected.key)
      .then((updated) => {
        setDraft(draftFromValue(updated));
        setAnnouncement(`reverted ${updated.key} to its default`);
        refresh(query);
      })
      .catch((err: unknown) => setError(messageFor(err)));
  }

  return (
    <div data-testid="settings-panel">
      <input
        aria-label="search settings"
        data-testid="settings-search-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="search by label, description, group, or key"
      />
      {groupRows(rows).map(({ group, rows: groupedRows }) => (
        <section key={group}>
          <h3>{group}</h3>
          <ul aria-label={`${group} settings`}>
            {groupedRows.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  data-testid={`settings-row-${row.key}`}
                  onClick={() => select(row)}
                >
                  {row.label}
                </button>
                {row.overridden ? <span> (overridden)</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {selected ? (
        <div data-testid="settings-detail" data-key={selected.key}>
          <h3>{selected.label}</h3>
          <p>{selected.description}</p>
          <div data-testid="settings-restart-status">
            {selected.appliesWithoutRestart
              ? "applies without a restart"
              : `restart required: ${selected.restartReason ?? "takes effect on the next start"}`}
          </div>
          {selected.envVar ? <div>env default: {selected.envVar}</div> : null}
          <div data-testid="settings-current-value">
            current value:{" "}
            {selected.sensitive
              ? selected.value === null
                ? "not set"
                : "[redacted]"
              : selected.type === "string[]" && Array.isArray(selected.value)
                ? selected.value.join(", ")
                : String(selected.value)}
          </div>

          {selected.type === "boolean" ? (
            <label>
              <input
                type="checkbox"
                data-testid="settings-value-input"
                checked={draft === "true"}
                onChange={(event) =>
                  setDraft(event.target.checked ? "true" : "false")
                }
              />
              enabled
            </label>
          ) : selected.type === "enum" ? (
            <select
              data-testid="settings-value-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            >
              {(selected.enumValues ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ) : (
            <input
              data-testid="settings-value-input"
              type={selected.type === "number" ? "number" : "text"}
              value={draft}
              placeholder={
                selected.sensitive
                  ? "write a new value — never echoed"
                  : undefined
              }
              onChange={(event) => setDraft(event.target.value)}
            />
          )}

          <button type="button" data-testid="settings-save" onClick={save}>
            save
          </button>
          <button
            type="button"
            data-testid="settings-remove-override"
            disabled={!selected.overridden}
            onClick={removeOverride}
          >
            remove override
          </button>
          {error ? <div data-testid="settings-error">{error}</div> : null}
        </div>
      ) : (
        <div>select a setting to view or change it</div>
      )}

      <LiveRegion
        message={announcement}
        label="settings status"
        testId="settings-panel-live-region"
      />
    </div>
  );
}
