import type {
  CSSProperties,
  KeyboardEvent,
  ReactElement,
  ReactNode,
} from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  nextRovingIndexSkippingDisabled,
  type RovingKey,
} from "./roving-tabindex.js";

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly panel: ReactNode;
  readonly disabled?: boolean;
}

export interface TabsProps {
  readonly tabs: readonly TabItem[];
  /** Uncontrolled initial selection; defaults to the first enabled tab. */
  readonly defaultSelectedId?: string;
}

const TAB_TRANSITION =
  "background-color var(--pr-dur-hover) var(--pr-ease), " +
  "border-color var(--pr-dur-hover) var(--pr-ease)";

const ROVING_KEYS: Record<string, true> = {
  ArrowLeft: true,
  ArrowRight: true,
  Home: true,
  End: true,
};

function initialSelection(
  tabs: readonly TabItem[],
  defaultSelectedId: string | undefined,
): { selectedId: string; focusIndex: number } {
  const byId = defaultSelectedId
    ? tabs.findIndex((tab) => tab.id === defaultSelectedId)
    : -1;
  if (byId >= 0 && !tabs[byId]?.disabled) {
    return { selectedId: tabs[byId]!.id, focusIndex: byId };
  }
  const firstEnabled = tabs.findIndex((tab) => !tab.disabled);
  const index = firstEnabled === -1 ? 0 : firstEnabled;
  return { selectedId: tabs[index]?.id ?? "", focusIndex: index };
}

/**
 * WAI-ARIA tabs (#102): a `role="tablist"` of `role="tab"` controls with
 * roving tabindex (Left/Right/Home/End) and automatic activation — focus and
 * selection move together. The active `role="tabpanel"` is the only one
 * rendered.
 */
export function Tabs({
  tabs,
  defaultSelectedId,
}: TabsProps): ReactElement | null {
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [{ selectedId, focusIndex }, setState] = useState(() =>
    initialSelection(tabs, defaultSelectedId),
  );

  const disabled = tabs.map((tab) => !!tab.disabled);
  const selectedIndex = tabs.findIndex((tab) => tab.id === selectedId);
  const selectedTab = tabs[selectedIndex];

  const tabId = (id: string): string => `${baseId}-tab-${id}`;
  const panelId = (id: string): string => `${baseId}-panel-${id}`;

  const activate = useCallback(
    (index: number) => {
      const tab = tabs[index];
      if (!tab || tab.disabled) return;
      setState({ selectedId: tab.id, focusIndex: index });
    },
    [tabs],
  );

  const moveFocus = useCallback(
    (key: RovingKey) => {
      const next = nextRovingIndexSkippingDisabled(
        focusIndex,
        disabled,
        key,
        "horizontal",
      );
      activate(next);
    },
    [activate, disabled, focusIndex],
  );

  useEffect(() => {
    tabRefs.current[focusIndex]?.focus();
  }, [focusIndex]);

  const onTabListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!ROVING_KEYS[event.key]) return;
    event.preventDefault();
    moveFocus(event.key as RovingKey);
  };

  if (tabs.length === 0) return null;

  const tabListStyle: CSSProperties = {
    display: "inline-flex",
    gap: "var(--pr-space-1)",
    padding: "var(--pr-space-1)",
  };

  const tabStyle: CSSProperties = {
    font: "var(--pr-type-chrome)",
    padding: "var(--pr-space-2) var(--pr-space-4)",
    transition: TAB_TRANSITION,
  };

  const panelStyle: CSSProperties = {
    marginTop: "var(--pr-space-3)",
    padding: "var(--pr-space-6)",
    font: "var(--pr-type-body)",
  };

  return (
    <div>
      <div
        role="tablist"
        className="inline-flex rounded-control border border-solid border-edge"
        style={tabListStyle}
        onKeyDown={onTabListKeyDown}
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === selectedId;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={index === focusIndex ? 0 : -1}
              disabled={tab.disabled}
              className={[
                "pr-focus-ring rounded-control border border-solid",
                selected
                  ? "border-edge bg-fill-4 text-text-1"
                  : "border-transparent bg-fill-2 text-text-2",
                tab.disabled
                  ? "cursor-default opacity-50"
                  : selected
                    ? "cursor-pointer"
                    : "cursor-pointer hover:bg-fill-3 active:bg-fill-4",
              ].join(" ")}
              style={tabStyle}
              onClick={() => activate(index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {selectedTab ? (
        <div
          role="tabpanel"
          id={panelId(selectedTab.id)}
          aria-labelledby={tabId(selectedTab.id)}
          tabIndex={0}
          className="rounded-block border border-solid border-edge bg-body-well inset-shadow-well"
          style={panelStyle}
        >
          {selectedTab.panel}
        </div>
      ) : null}
    </div>
  );
}
