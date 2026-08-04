/**
 * The Search panel (§6.8, Epic 8.2): "search spans every session, including
 * archived ones, ranked over title, location, and content; archived
 * sessions are reported as archived rather than hidden, because finding
 * them is the point." The operator's browse surface for what is not on
 * canvas (archive-by-default, §3.3).
 *
 * A real combobox (§11), the same shape `CommandPalette` already uses: a
 * text input plus a listbox of results, `aria-activedescendant` naming the
 * highlighted hit so the highlight is announced rather than merely drawn.
 * Unlike the palette this is a dock panel, not a modal — its keys are a
 * registered `list` binding (scope `list`, surface `search-panel`), not a
 * `dialog` one, and there is no focus trap: leaving the panel by Tab is
 * ordinary keyboard movement, not something to hold onto.
 *
 * Results render exactly in the order the API returns them (already ranked
 * server-side); this component reorders nothing. Selecting a hit — by
 * Enter or by click — goes through the one selection-as-route primitive
 * (`onSelectNode`, spec §5) and never a second navigation path. A hit whose
 * referenced node is not currently on the canvas still calls the same
 * primitive; whether that resolves to anything visible is the canvas's own
 * concern; nothing here holds an off-canvas special case.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { KeyBinding } from "../keyboard/bindings.js";
import { useKeyBindings } from "../keyboard/use-key-bindings.js";
import { LiveRegion } from "../keyboard/LiveRegion.js";
import type { SearchDataSource, SearchHit } from "./types.js";

const SURFACE = "search-panel";
/** Debounces keystrokes into one bounded read, not one request per key. */
const QUERY_DEBOUNCE_MS = 150;

export interface SearchPanelProps {
  readonly dataSource: SearchDataSource;
  readonly onSelectNode: (nodeId: string) => void;
}

function summarize(hits: readonly SearchHit[], query: string): string {
  if (query.trim().length === 0) return "";
  if (hits.length === 0) return `no results for "${query}"`;
  return `${hits.length} result${hits.length === 1 ? "" : "s"} for "${query}"`;
}

export function SearchPanel({ dataSource, onSelectNode }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits([]);
      setActiveIndex(0);
      return;
    }
    const requestId = ++requestIdRef.current;
    const timer = setTimeout(() => {
      void dataSource.search({ q: trimmed }).then((result) => {
        // A slower, stale request must never clobber a faster, newer one.
        if (requestIdRef.current !== requestId) return;
        setHits(result.hits);
        setActiveIndex(0);
      });
    }, QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, dataSource]);

  function activate(hit: SearchHit): void {
    onSelectNode(hit.refId);
  }

  const hitsRef = useRef(hits);
  hitsRef.current = hits;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  const bindings = useMemo<readonly KeyBinding[]>(() => {
    function move(delta: number): void {
      const count = hitsRef.current.length;
      setActiveIndex((current) =>
        count === 0 ? 0 : (current + delta + count) % count,
      );
    }
    return [
      {
        kind: "dispatched",
        id: "search-panel-next",
        chords: [{ key: "ArrowDown" }],
        label: "highlight the next search result",
        description:
          "moves the search panel's highlight down, wrapping at the end",
        scope: "list",
        surface: SURFACE,
        allowInTextEntry: true,
        run: () => move(1),
      },
      {
        kind: "dispatched",
        id: "search-panel-prev",
        chords: [{ key: "ArrowUp" }],
        label: "highlight the previous search result",
        description:
          "moves the search panel's highlight up, wrapping at the start",
        scope: "list",
        surface: SURFACE,
        allowInTextEntry: true,
        run: () => move(-1),
      },
      {
        kind: "dispatched",
        id: "search-panel-activate",
        chords: [{ key: "Enter" }],
        label: "select the highlighted search result",
        description:
          "navigates to the highlighted hit (§5) — the same selection primitive a click uses",
        scope: "list",
        surface: SURFACE,
        allowInTextEntry: true,
        run: () => {
          const hit = hitsRef.current[activeIndexRef.current];
          if (hit) activate(hit);
        },
      },
    ];
  }, []);
  useKeyBindings(bindings);

  const activeOptionId = hits[activeIndex]
    ? `search-result-${hits[activeIndex]?.refKind}-${hits[activeIndex]?.refId}`
    : undefined;

  return (
    <div data-testid="search-panel" data-key-scope={`list:${SURFACE}`}>
      <input
        role="combobox"
        aria-label="search"
        aria-expanded
        aria-controls="search-results-listbox"
        aria-autocomplete="list"
        data-testid="search-panel-input"
        {...(activeOptionId === undefined
          ? {}
          : { "aria-activedescendant": activeOptionId })}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="search sessions, including archived ones (§6.8)"
      />
      <ul
        id="search-results-listbox"
        role="listbox"
        aria-label="search results"
        data-testid="search-panel-results"
      >
        {hits.map((hit, index) => {
          const optionId = `search-result-${hit.refKind}-${hit.refId}`;
          return (
            <li
              key={optionId}
              id={optionId}
              role="option"
              aria-selected={index === activeIndex}
              data-testid="search-result"
            >
              <button type="button" onClick={() => activate(hit)}>
                {hit.title}
              </button>{" "}
              <span>{hit.location}</span>
              {/* Archived is reported, never hidden (§6.8) — the hit stays a
                  row and this text says what it is. */}
              {hit.archived ? (
                <strong data-testid="search-result-archived">
                  {" "}
                  (archived)
                </strong>
              ) : null}
              <div>{hit.snippet}</div>
            </li>
          );
        })}
      </ul>
      <LiveRegion
        message={summarize(hits, query)}
        label="search results summary"
        testId="search-panel-live-region"
      />
    </div>
  );
}
