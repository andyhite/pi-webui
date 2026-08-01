/**
 * Renders one plugin-contributed `DraftPanel` inside the dock rail (§10.1,
 * §11). `DraftPanel.render()` is async and may throw — a throwing panel
 * degrades to a reported message here, never to a crashed dock rail
 * (§10.2: a throwing contribution is an unavailable contribution).
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useState } from "react";
import type { draft } from "@plotroom/plugin-sdk";

export interface PluginPanelViewProps {
  readonly panel: draft.DraftPanel;
}

type ViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly view: draft.DraftCardView }
  | { readonly kind: "failed"; readonly reason: string };

export function PluginPanelView({ panel }: PluginPanelViewProps) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    panel
      .render()
      .then((view) => {
        if (!cancelled) setState({ kind: "ready", view });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [panel]);

  if (state.kind === "loading") return <div>loading {panel.title}…</div>;
  if (state.kind === "failed") {
    return (
      <div data-testid={`plugin-panel-failed-${panel.id}`}>
        plugin panel unavailable: {state.reason}
      </div>
    );
  }
  return (
    <div data-testid={`plugin-panel-${panel.id}`}>
      <div>{state.view.title}</div>
      <ul>
        {state.view.lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
