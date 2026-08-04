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
 * a plain, unprefilled input — the real value is never echoed back into it,
 * before or after a write. Both draft rules — that one, and the refusal of an
 * empty number field rather than the zero `Number("")` is — live in
 * `draft.ts`, next to the server's own `checkSettingValue` in shape.
 *
 * A grouped, searchable list (plain buttons, keyboard-reachable by Tab like
 * `GraphWarningsPanel`) rather than a combobox: unlike Search there is no
 * single flat ranked result list to highlight, so no new key binding is
 * needed here at all.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useRef, useState } from "react";

import { LiveRegion } from "../keyboard/LiveRegion.js";
import { checkDraft, draftFromValue, parseDraft } from "./draft.js";
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

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SettingsPanel({ dataSource }: SettingsPanelProps) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<readonly SettingRow[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [announcement, setAnnouncement] = useState<string | null>(null);
  // Two kinds of failure, one surface. A *read* failure is a property of what
  // is on screen, so a read that answers clears it; a refused *gesture* is
  // feedback for something the operator just did, and a background refresh
  // arriving a moment later must not erase it.
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = readError ?? actionError;

  // The WS subscription below outlives the render it was made in, so the
  // filter its refresh re-reads has to be a ref: captured, a refresh arriving
  // after the operator had typed re-listed the whole catalog unfiltered, and
  // resubscribing per keystroke to keep the value fresh would tear the socket
  // listener down and rebuild it on every character.
  const queryRef = useRef(query);
  queryRef.current = query;

  function refresh(): void {
    void dataSource
      .list(queryRef.current || undefined)
      .then((next) => {
        setRows(next);
        setReadError(null);
      })
      // A failed read that left the previous rows standing said nothing at
      // all — the operator reads a stale list as the current one.
      .catch((err: unknown) => {
        setRows([]);
        setReadError(`could not read the settings: ${messageFor(err)}`);
      });
  }

  useEffect(() => {
    refresh();
  }, [query, dataSource]);

  useEffect(() => {
    return dataSource.subscribe(() => refresh());
  }, [dataSource]);

  const selected = rows.find((row) => row.key === selectedKey) ?? null;

  function select(row: SettingRow): void {
    setSelectedKey(row.key);
    setDraft(draftFromValue(row));
    setActionError(null);
  }

  function save(): void {
    if (!selected) return;
    const refusal = checkDraft(selected, draft);
    if (refusal) {
      // Named as the route names it (`"<key>" must be …`), so a refusal from
      // the panel and one from the server do not read as two different rules
      // in the same element.
      setActionError(`"${selected.key}" must be ${refusal}`);
      return;
    }
    setActionError(null);
    void dataSource
      .set(selected.key, parseDraft(selected, draft))
      .then((updated) => {
        // Reseeded from what the write returned, which for a sensitive
        // setting is empty: the value the operator typed does not stay in
        // the field once it has been written.
        setDraft(draftFromValue(updated));
        setAnnouncement(
          updated.appliesWithoutRestart
            ? `saved ${updated.key}, applied without a restart`
            : `saved ${updated.key} — restart required: ${updated.restartReason ?? "takes effect on the next start"}`,
        );
        refresh();
      })
      .catch((err: unknown) => setActionError(messageFor(err)));
  }

  function removeOverride(): void {
    if (!selected) return;
    setActionError(null);
    void dataSource
      .remove(selected.key)
      .then((updated) => {
        setDraft(draftFromValue(updated));
        setAnnouncement(`reverted ${updated.key} to its default`);
        refresh();
      })
      .catch((err: unknown) => setActionError(messageFor(err)));
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
                {row.ignoredReason ? (
                  <span> (stored value ignored)</span>
                ) : null}
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
          {selected.ignoredReason ? (
            <div data-testid="settings-ignored-reason">
              stored value ignored: {selected.ignoredReason}
            </div>
          ) : null}
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
            // An ignored row is not "overridden" — the process is running the
            // default — but it is still a row, and removing it is the only way to
            // clear it from a surface. Disabling this for one would have taken
            // away the operator's way out of exactly the state the ignore exists
            // to report.
            disabled={!selected.overridden && !selected.ignoredReason}
            onClick={removeOverride}
          >
            remove override
          </button>
        </div>
      ) : (
        <div>select a setting to view or change it</div>
      )}

      {/* Panel-level, not inside the detail: a failed list read clears the
          rows, which unselects, which would have unmounted the very element
          the failure was written into — a report nobody can see is the silence
          it was meant to replace. One surface for every refusal here, whether
          it came from a read, a save, or a remove. */}
      {error ? <div data-testid="settings-error">{error}</div> : null}

      <LiveRegion
        message={announcement}
        label="settings status"
        testId="settings-panel-live-region"
      />
    </div>
  );
}
