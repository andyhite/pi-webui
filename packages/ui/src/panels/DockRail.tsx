/**
 * The dock rail (spec §11): one open panel at a time, closing is cheap
 * because state persists across close/reopen. State lives here, in
 * `DockRail`'s own component state — one entry per panel id, in a bag that is
 * never touched by which panel happens to be open. A closed panel's
 * component unmounts (only the open one renders), but its entry in
 * `panelStates` survives untouched, so reopening it hands the same state
 * right back.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useState } from "react";

import type { PanelRegistry } from "./registry.js";
import { nextOpenPanelId, withPanelState } from "./registry.js";

export interface DockRailProps {
  readonly registry: PanelRegistry;
}

export function DockRail({ registry }: DockRailProps) {
  const panels = registry.list();
  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  const [panelStates, setPanelStates] = useState<
    Readonly<Record<string, unknown>>
  >(() => {
    const initial: Record<string, unknown> = {};
    for (const panel of panels) initial[panel.id] = panel.initialState;
    return initial;
  });

  const openPanel = openPanelId ? registry.get(openPanelId) : undefined;

  return (
    <div>
      <nav>
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            aria-pressed={panel.id === openPanelId}
            onClick={() =>
              setOpenPanelId((current) => nextOpenPanelId(current, panel.id))
            }
          >
            {panel.title}
          </button>
        ))}
      </nav>
      {openPanel ? (
        <div role="region" aria-label={openPanel.title}>
          {openPanel.render({
            state: panelStates[openPanel.id] ?? openPanel.initialState,
            setState: (next) =>
              setPanelStates((current) =>
                withPanelState(current, openPanel.id, next),
              ),
          })}
        </div>
      ) : null}
    </div>
  );
}
