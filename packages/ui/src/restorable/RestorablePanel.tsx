/**
 * The restorable/undo panel (issue #65, spec §5, principle 10): "deletion is
 * recoverable for authored state — including when an agent did the deleting."
 * `GET /api/restorable` had no reader at all before this; a one-shot load
 * with a manual refresh stands in for a live subscription, the same
 * trade-off `FleetPanel` already makes for the same reason (nothing pushes a
 * restorable-changed event yet).
 *
 * One row per deleted entity, across all seven kinds `restorable.ts` lists —
 * every restore verb lives on the entity itself
 * (`POST /api/<kind>/:id/restore`), so this panel picks the right one by
 * `RestorableKind` and never guesses from the id's shape. A restore that the
 * server refuses (an already-restored row, a parent still gone) is reported
 * inline rather than swallowed; a successful one reloads the list so the row
 * it just brought back disappears from here (it is back on the canvas, or
 * wherever else it belongs, instead).
 *
 * Held back from #42 deliberately: what a *styled* undo surface looks like
 * is the design package's call (#51), not one invented under the freeze.
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useState } from "react";

import type { ActionResult } from "../data-source/actions.js";
import type {
  RestorableDataSource,
  RestorableKind,
  RestorableSummary,
} from "./types.js";

export interface RestorablePanelProps {
  readonly dataSource: RestorableDataSource;
  readonly restoreEntity: (
    kind: RestorableKind,
    id: string,
  ) => Promise<ActionResult<void>>;
}

interface Section {
  readonly kind: RestorableKind;
  readonly label: string;
  readonly rows: readonly { readonly id: string; readonly detail: string }[];
}

function sections(summary: RestorableSummary): readonly Section[] {
  return [
    {
      kind: "object",
      label: "objects",
      rows: summary.objects.map((row) => ({ id: row.id, detail: row.title })),
    },
    {
      kind: "node",
      label: "nodes",
      rows: summary.nodes.map((row) => ({
        id: row.id,
        detail: `${row.role} → ${row.refId}`,
      })),
    },
    {
      kind: "edge",
      label: "edges",
      rows: summary.edges.map((row) => ({
        id: row.id,
        detail: `${row.kind}: ${row.from} → ${row.to}`,
      })),
    },
    {
      kind: "workstream",
      label: "workstreams",
      rows: summary.workstreams.map((row) => ({
        id: row.id,
        detail: row.subjectId ?? "(no subject)",
      })),
    },
    {
      kind: "command",
      label: "commands",
      rows: summary.commands.map((row) => ({
        id: row.id,
        detail: row.definitionId,
      })),
    },
    {
      kind: "commandDefinition",
      label: "command definitions",
      rows: summary.commandDefinitions.map((row) => ({
        id: row.id,
        detail: row.name,
      })),
    },
    {
      kind: "session",
      label: "sessions",
      rows: summary.sessions.map((row) => ({
        id: row.id,
        detail: `${row.workstreamId ?? "(no workstream)"}${
          row.end ? `, ended ${row.end.kind}` : ""
        }`,
      })),
    },
  ];
}

export function RestorablePanel({
  dataSource,
  restoreEntity,
}: RestorablePanelProps) {
  const [summary, setSummary] = useState<RestorableSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void dataSource.load().then((next) => {
      if (!cancelled) setSummary(next);
    });
    return () => {
      cancelled = true;
    };
  }, [dataSource]);

  function refresh(): void {
    void dataSource.load().then(setSummary);
  }

  function restore(kind: RestorableKind, id: string): void {
    void restoreEntity(kind, id).then((result) => {
      if (!result.ok) {
        setError(`refused to restore ${kind} ${id}: ${result.refusal.message}`);
        return;
      }
      setError(null);
      refresh();
    });
  }

  if (!summary) return <div>loading what can be undone…</div>;

  const totalRows = sections(summary).reduce(
    (sum, section) => sum + section.rows.length,
    0,
  );

  return (
    <div data-testid="restorable-panel">
      <button type="button" onClick={refresh}>
        refresh
      </button>
      {error ? <div role="alert">{error}</div> : null}
      {totalRows === 0 ? (
        <div>nothing deleted is waiting to be restored</div>
      ) : null}
      {sections(summary)
        .filter((section) => section.rows.length > 0)
        .map((section) => (
          <div key={section.kind}>
            <div>{section.label}</div>
            <ul aria-label={section.label}>
              {section.rows.map((row) => (
                <li key={row.id} data-testid={`restorable-row-${row.id}`}>
                  {row.id} — {row.detail}{" "}
                  <button
                    type="button"
                    onClick={() => restore(section.kind, row.id)}
                  >
                    restore
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}
