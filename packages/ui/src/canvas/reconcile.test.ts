import { describe, expect, it } from "vitest";

import { remotelyDeletedIds, withConfirmed } from "./reconcile.js";

describe("withConfirmed", () => {
  it("unions ids into the confirmed set", () => {
    expect(withConfirmed(new Set(["a"]), ["b", "c"])).toEqual(
      new Set(["a", "b", "c"]),
    );
  });

  it("returns an equivalent set for an empty id list", () => {
    const confirmed = new Set(["a"]);
    expect(withConfirmed(confirmed, [])).toEqual(confirmed);
  });
});

describe("remotelyDeletedIds", () => {
  it("removes an id another client deleted: confirmed before, missing now", () => {
    const confirmed = new Set(["a", "b"]);
    expect(remotelyDeletedIds(["a", "b"], ["a"], confirmed)).toEqual(["b"]);
  });

  it("never removes an optimistic local-only id that was never confirmed", () => {
    // e.g. an edge just drawn locally by onConnect, under a client-side id
    // the host has never named in any incoming snapshot.
    const confirmed = new Set(["a"]);
    expect(remotelyDeletedIds(["a", "local-edge-1"], ["a"], confirmed)).toEqual(
      [],
    );
  });

  it("keeps a confirmed id that is still present upstream", () => {
    const confirmed = new Set(["a", "b"]);
    expect(remotelyDeletedIds(["a", "b"], ["a", "b"], confirmed)).toEqual([]);
  });

  it("is a no-op for a locally tombstoned id already absent from current", () => {
    // A locally deleted node is removed from `current` before this ever
    // runs; the host's arrays still name it (deletion isn't surfaced yet),
    // so there is nothing in `currentIds` for this function to touch.
    const confirmed = new Set(["a"]);
    expect(remotelyDeletedIds([], ["a"], confirmed)).toEqual([]);
  });

  it("returns nothing when nothing is confirmed yet", () => {
    expect(remotelyDeletedIds(["a"], [], new Set())).toEqual([]);
  });
});
