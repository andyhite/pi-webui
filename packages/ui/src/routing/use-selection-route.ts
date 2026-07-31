import { useCallback, useEffect, useState } from "react";

import { searchForSelection, selectionFromSearch } from "./selection.js";

/**
 * The one navigation primitive (spec §5). Every entry point — a click, a
 * deep link, later the palette and the queue — selects through this hook,
 * so the address bar and the canvas can never disagree.
 */
export function useSelectionRoute(): {
  selectedNodeId: string | null;
  select: (nodeId: string | null) => void;
} {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() =>
    selectionFromSearch(window.location.search),
  );

  useEffect(() => {
    const onPopState = () => {
      setSelectedNodeId(selectionFromSearch(window.location.search));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const select = useCallback((nodeId: string | null) => {
    setSelectedNodeId((current) => {
      if (current === nodeId) return current;
      const search = searchForSelection(window.location.search, nodeId);
      window.history.pushState(
        null,
        "",
        `${window.location.pathname}${search}${window.location.hash}`,
      );
      return nodeId;
    });
  }, []);

  return { selectedNodeId, select };
}
