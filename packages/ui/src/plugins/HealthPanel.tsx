/**
 * The plugin health panel (§10.2, §11): every installed plugin, its
 * lifecycle state (with a reason once it degrades), its integration health
 * (when one exists) named in §10.2's own words, and the enable/disable/
 * remove verbs. Fixture-fed until the host lands its lifecycle events on
 * `main` — see `health-data-source.ts` and `lifecycle-actions.ts`.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useState } from "react";

import type { PluginHealthDataSource } from "./health-data-source.js";
import type { PluginLifecycleActions } from "./lifecycle-actions.js";
import type { PluginHealthEntry } from "./types.js";

export interface PluginHealthPanelProps {
  readonly dataSource: PluginHealthDataSource;
  readonly actions: PluginLifecycleActions;
}

type VerbName = "enable" | "disable" | "remove";

export function PluginHealthPanel({
  dataSource,
  actions,
}: PluginHealthPanelProps) {
  const [entries, setEntries] = useState<readonly PluginHealthEntry[]>([]);
  const [messages, setMessages] = useState<Readonly<Record<string, string>>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    void dataSource.load().then((next) => {
      if (!cancelled) setEntries(next);
    });
    const unsubscribe = dataSource.subscribe((next) => setEntries(next));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dataSource]);

  function runVerb(pluginId: string, verb: VerbName): void {
    void actions[verb](pluginId).then((result) => {
      setMessages((current) => ({
        ...current,
        [pluginId]: result.ok
          ? `${verb} succeeded`
          : `refused: ${result.refusal.reason} — ${result.refusal.message}`,
      }));
    });
  }

  if (entries.length === 0) {
    return <div data-testid="plugin-health-panel">no plugins installed</div>;
  }

  return (
    <div data-testid="plugin-health-panel">
      <ul aria-label="installed plugins">
        {entries.map((entry) => (
          <li
            key={entry.pluginId}
            data-testid={`plugin-health-${entry.pluginId}`}
          >
            <strong>{entry.name}</strong>{" "}
            <span data-testid={`plugin-lifecycle-${entry.pluginId}`}>
              {entry.lifecycle.status}
              {entry.lifecycle.reason ? ` (${entry.lifecycle.reason})` : ""}
            </span>
            {entry.integration ? (
              <span data-testid={`plugin-integration-${entry.pluginId}`}>
                {" — integration: "}
                {entry.integration.state} ({entry.integration.detail})
              </span>
            ) : (
              <span data-testid={`plugin-integration-${entry.pluginId}`}>
                {" — integration: none reported yet"}
              </span>
            )}
            <div>
              <button
                type="button"
                onClick={() => runVerb(entry.pluginId, "enable")}
              >
                enable
              </button>
              <button
                type="button"
                onClick={() => runVerb(entry.pluginId, "disable")}
              >
                disable
              </button>
              <button
                type="button"
                onClick={() => runVerb(entry.pluginId, "remove")}
              >
                remove
              </button>
            </div>
            {messages[entry.pluginId] ? (
              <div data-testid={`plugin-message-${entry.pluginId}`}>
                {messages[entry.pluginId]}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
