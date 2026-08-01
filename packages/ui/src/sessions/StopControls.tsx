/**
 * Stop at three scopes (spec §6.7): one session, a workstream, everything
 * running. "A stop names how many it will affect, is disabled when nothing
 * is running, and confirms at the widest scope." Unstyled: mechanics only
 * until the design package lands (fleet rule 5).
 *
 * The count/enabled state comes from `previewStop` (`GET /stops/preview`,
 * a read — looking is free); the widest-scope confirmation gate rides the
 * same refusal channel every other gesture uses, not a separate client-side
 * rule: `stopScope` is called with `confirm: false` first, and a
 * `confirmation_required` refusal is what turns this into a two-step
 * gesture — the server's own gate, not a guess repeated here.
 */

import { useCallback, useEffect, useState } from "react";

import type { StopPreview, StopScopeInput } from "../data-source/actions.js";
import type { ActionResult } from "../data-source/actions.js";

export interface StopControlsProps {
  /** Null when nothing is selected — the session-scope button disables honestly. */
  readonly selectedSessionId: string | null;
  /** Null when the selection is not inside a workstream. */
  readonly selectedWorkstreamId: string | null;
  readonly previewStop: (scope: StopScopeInput) => Promise<StopPreview>;
  readonly stopScope: (
    input: StopScopeInput & { readonly confirm?: boolean },
  ) => Promise<ActionResult<{ readonly stoppedSessionIds: readonly string[] }>>;
  readonly onStopped?: (
    scope: StopScopeInput,
    stoppedSessionIds: readonly string[],
  ) => void;
  readonly onRefused?: (scope: StopScopeInput, message: string) => void;
}

type ScopeKind = StopScopeInput["scope"];

function scopeFor(
  kind: ScopeKind,
  selectedSessionId: string | null,
  selectedWorkstreamId: string | null,
): StopScopeInput | null {
  if (kind === "session") {
    return selectedSessionId
      ? { scope: "session", sessionId: selectedSessionId }
      : null;
  }
  if (kind === "workstream") {
    return selectedWorkstreamId
      ? { scope: "workstream", workstreamId: selectedWorkstreamId }
      : null;
  }
  return { scope: "everything" };
}

export function StopControls({
  selectedSessionId,
  selectedWorkstreamId,
  previewStop,
  stopScope,
  onStopped,
  onRefused,
}: StopControlsProps) {
  const [previews, setPreviews] = useState<
    Partial<Record<ScopeKind, StopPreview>>
  >({});
  const [pendingConfirm, setPendingConfirm] = useState<{
    readonly scope: StopScopeInput;
    readonly description: string;
  } | null>(null);

  const refresh = useCallback(() => {
    for (const kind of ["session", "workstream", "everything"] as const) {
      const scope = scopeFor(kind, selectedSessionId, selectedWorkstreamId);
      if (!scope) {
        setPreviews((current) => ({ ...current, [kind]: undefined }));
        continue;
      }
      void previewStop(scope).then((preview) => {
        setPreviews((current) => ({ ...current, [kind]: preview }));
      });
    }
  }, [selectedSessionId, selectedWorkstreamId, previewStop]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function attemptStop(
    scope: StopScopeInput,
    confirm: boolean,
  ): Promise<void> {
    const result = await stopScope({ ...scope, confirm });
    if (result.ok) {
      setPendingConfirm(null);
      onStopped?.(scope, result.value.stoppedSessionIds);
      refresh();
      return;
    }
    if (result.refusal.reason === "confirmation_required") {
      setPendingConfirm({ scope, description: result.refusal.message });
      return;
    }
    setPendingConfirm(null);
    onRefused?.(scope, result.refusal.message);
  }

  function StopButton({
    kind,
    label,
  }: {
    readonly kind: ScopeKind;
    readonly label: string;
  }) {
    const scope = scopeFor(kind, selectedSessionId, selectedWorkstreamId);
    const preview = previews[kind];
    const enabled = scope !== null && (preview?.enabled ?? false);
    return (
      <div>
        <button
          type="button"
          data-testid={`stop-${kind}`}
          disabled={!enabled}
          onClick={() => scope && void attemptStop(scope, false)}
        >
          {label}
          {preview ? ` (${preview.count})` : ""}
        </button>
      </div>
    );
  }

  return (
    <div>
      <StopButton kind="session" label="stop selected session" />
      <StopButton kind="workstream" label="stop this workstream" />
      <StopButton kind="everything" label="stop everything running" />
      {pendingConfirm ? (
        <div data-testid="stop-confirm">
          <div>{pendingConfirm.description}</div>
          <button
            type="button"
            data-testid="stop-confirm-yes"
            onClick={() => void attemptStop(pendingConfirm.scope, true)}
          >
            confirm
          </button>
          <button type="button" onClick={() => setPendingConfirm(null)}>
            cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
