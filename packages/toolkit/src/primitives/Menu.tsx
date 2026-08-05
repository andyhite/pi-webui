import type {
  CSSProperties,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "./Button.js";
import {
  nextRovingIndexSkippingDisabled,
  type RovingKey,
} from "./roving-tabindex.js";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
}

export interface MenuProps {
  readonly items: readonly MenuItem[];
  /**
   * Trigger content. A `string` renders the default `Button`; any other node
   * is passed through — a single `Button`/`IconButton` element is cloned with
   * the menu's `aria-haspopup`/`aria-expanded` and click handler.
   */
  readonly trigger: ReactNode;
}

// §18's panel glass recipe — same float surface as `Panel`, scaled to a menu
// popover (`radius-block` rather than `radius-panel`).
const MENU_SURFACE: CSSProperties = {
  background: "var(--pr-glass-panel)",
  boxShadow: "var(--pr-shadow-panel)",
  borderRadius: "var(--pr-radius-block)",
  backdropFilter: "var(--pr-blur-panel)",
  WebkitBackdropFilter: "var(--pr-blur-panel)",
};

const ITEM_TRANSITION = "background-color var(--pr-dur-hover) var(--pr-ease)";

const ROVING_KEYS: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  Home: true,
  End: true,
};

function firstEnabledIndex(disabled: readonly boolean[]): number {
  const index = disabled.findIndex((d) => !d);
  return index === -1 ? 0 : index;
}

/**
 * WAI-ARIA menu button (#102): a trigger opens a `role="menu"` list of
 * `role="menuitem"` entries. Arrow Up/Down/Home/End rove focus; Escape,
 * outside-click, and item-select close and return focus to the trigger.
 */
export function Menu({ items, trigger }: MenuProps): ReactElement {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerWrapRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);

  const disabled = items.map((item) => !!item.disabled);

  const focusTrigger = useCallback(() => {
    triggerWrapRef.current?.querySelector("button")?.focus();
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    focusTrigger();
  }, [focusTrigger]);

  const openMenu = useCallback(() => {
    const first = firstEnabledIndex(disabled);
    setFocusIndex(first);
    setOpen(true);
  }, [disabled]);

  const toggleMenu = useCallback(() => {
    if (open) closeMenu();
    else openMenu();
  }, [closeMenu, open, openMenu]);

  const selectIndex = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item || item.disabled) return;
      item.onSelect();
      closeMenu();
    },
    [closeMenu, items],
  );

  const moveFocus = useCallback(
    (key: RovingKey) => {
      setFocusIndex((current) =>
        nextRovingIndexSkippingDisabled(current, disabled, key, "vertical"),
      );
    },
    [disabled],
  );

  useEffect(() => {
    if (!open) return;
    itemRefs.current[focusIndex]?.focus();
  }, [focusIndex, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [closeMenu, open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    if (ROVING_KEYS[event.key]) {
      event.preventDefault();
      moveFocus(event.key as RovingKey);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectIndex(focusIndex);
    }
  };

  const menuTriggerProps = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: toggleMenu,
  };

  const triggerNode =
    typeof trigger === "string" ? (
      <Button {...menuTriggerProps}>{trigger}</Button>
    ) : isValidElement(trigger) ? (
      cloneElement(
        trigger as ReactElement<{
          onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
        }>,
        {
          ...menuTriggerProps,
          onClick: (event: MouseEvent<HTMLButtonElement>) => {
            (
              trigger as ReactElement<{
                onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
              }>
            ).props.onClick?.(event);
            toggleMenu();
          },
        },
      )
    ) : (
      <Button {...menuTriggerProps}>{trigger}</Button>
    );

  return (
    <div
      ref={rootRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <span ref={triggerWrapRef}>{triggerNode}</span>
      {open ? (
        <ul
          id={menuId}
          role="menu"
          onKeyDown={onMenuKeyDown}
          className="border border-solid border-edge inset-shadow-lip"
          style={{
            ...MENU_SURFACE,
            position: "absolute",
            top: "100%",
            left: 0,
            minWidth: "100%",
            padding: "var(--pr-space-2)",
            listStyle: "none",
            margin: 0,
            marginTop: "var(--pr-space-2)",
          }}
        >
          {items.map((item, index) => (
            <li key={item.id} role="none">
              <button
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitem"
                tabIndex={index === focusIndex ? 0 : -1}
                disabled={item.disabled}
                aria-disabled={item.disabled || undefined}
                className={[
                  "pr-focus-ring w-full rounded-control text-left",
                  "bg-fill-2 text-text-1",
                  item.disabled
                    ? "cursor-default opacity-50"
                    : "cursor-pointer hover:bg-fill-3 active:bg-fill-4",
                ].join(" ")}
                style={{
                  font: "var(--pr-type-chrome)",
                  padding: "var(--pr-space-2) var(--pr-space-3)",
                  border: "none",
                  transition: ITEM_TRANSITION,
                }}
                onClick={() => selectIndex(index)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
