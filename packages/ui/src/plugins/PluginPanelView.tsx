/**
 * Renders one plugin-contributed `Panel` inside the dock rail (§10.1,
 * §11). `Panel.render()` is async and may throw — a throwing panel
 * degrades to a reported message here, never to a crashed dock rail
 * (§10.2: a throwing contribution is an unavailable contribution).
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useState } from "react";
import type { CardView, Panel } from "@plotroom/plugin-sdk";

import { createRendererCallContext } from "./call-context.js";

export interface PluginPanelViewProps {
  readonly panel: Panel;
}

export type PluginPanelViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly view: CardView }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * The one place a rejected `render()` becomes the "failed" state, pulled out
 * of the effect so the degrade-on-throw rule (§10.2) is testable without
 * mounting a component. Never throws itself — `panel.render()`'s rejection
 * reason is read defensively (`Error` or coerced to a string) the same way
 * the effect below already did.
 */
export async function resolvePluginPanelViewState(
  panel: Panel,
): Promise<PluginPanelViewState> {
  try {
    const view = await panel.render(createRendererCallContext());
    return { kind: "ready", view };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function PluginPanelView({ panel }: PluginPanelViewProps) {
  const [state, setState] = useState<PluginPanelViewState>({
    kind: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void resolvePluginPanelViewState(panel).then((next) => {
      if (!cancelled) setState(next);
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
