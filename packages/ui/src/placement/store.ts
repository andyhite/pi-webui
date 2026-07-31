/**
 * Durable placement (spec §5): arranging by hand never costs an earlier
 * placement, including across restarts.
 *
 * The interface is deliberately small and async so today's localStorage
 * implementation can be swapped for the server API (Phase 2) without
 * touching the canvas. Callers never talk to storage directly.
 */

import type { Point } from "../solver/push.js";

/** Node id → canvas position. */
export type Placements = Readonly<Record<string, Point>>;

export interface PlacementStore {
  load(): Promise<Placements>;
  save(placements: Placements): Promise<void>;
}

/** The subset of the Web Storage API the store needs; injectable for tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isPoint(value: unknown): value is Point {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { x: unknown }).x === "number" &&
    typeof (value as { y: unknown }).y === "number" &&
    Number.isFinite((value as { x: number }).x) &&
    Number.isFinite((value as { y: number }).y)
  );
}

/** Parse stored JSON defensively: anything malformed yields no placements. */
export function parsePlacements(raw: string | null): Placements {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, Point> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (isPoint(value)) {
      result[id] = { x: value.x, y: value.y };
    }
  }
  return result;
}

/** Placement store over Web Storage (localStorage until the API exists). */
export function createWebStoragePlacementStore(
  storage: StorageLike,
  key: string,
): PlacementStore {
  return {
    load(): Promise<Placements> {
      return Promise.resolve(parsePlacements(storage.getItem(key)));
    },
    save(placements: Placements): Promise<void> {
      storage.setItem(key, JSON.stringify(placements));
      return Promise.resolve();
    },
  };
}

/** In-memory store for tests and fixture setups. */
export function createMemoryPlacementStore(
  initial: Placements = {},
): PlacementStore {
  let current: Placements = initial;
  return {
    load(): Promise<Placements> {
      return Promise.resolve(current);
    },
    save(placements: Placements): Promise<void> {
      current = placements;
      return Promise.resolve();
    },
  };
}
