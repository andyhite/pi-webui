/**
 * Selection is the route (spec §5): the selected node is reflected in the
 * address, and a refresh or shared link lands on the same node. These pure
 * helpers define the address form; `useSelectionRoute` is the one
 * navigation primitive every entry point goes through.
 */

const PARAM = "node";

/** Read the selected node id out of a query string (`location.search`). */
export function selectionFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const id = params.get(PARAM);
  return id === null || id === "" ? null : id;
}

/** Produce the query string that addresses `nodeId` (or no selection). */
export function searchForSelection(
  search: string,
  nodeId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (nodeId === null) {
    params.delete(PARAM);
  } else {
    params.set(PARAM, nodeId);
  }
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}
