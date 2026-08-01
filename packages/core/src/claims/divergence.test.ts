import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import type { DivergenceReport } from "../workspaces/divergence.js";
import {
  checkClaimContinuation,
  deriveClaimStaleReads,
  isPathAttributable,
  type PathRead,
  type PathWrite,
} from "./divergence.js";
import type { ClaimId } from "./ids.js";
import { claimPath } from "./paths.js";
import { session } from "./testing.js";

const A = session("sess_a");
const B = session("sess_b");

const CLAIM = "claim_x" as ClaimId;

function read(path: string, at: number): PathRead {
  return { path: claimPath(path), at };
}

function write(path: string, at: number, by = sessionAuthor(B)): PathWrite {
  return {
    path: claimPath(path),
    holder: by,
    claimId: by.kind === "human" ? null : CLAIM,
    at,
  };
}

function report(
  changes: DivergenceReport["changes"],
  observedAt = 1_700_000_000_000,
): DivergenceReport {
  return { diverged: changes.length > 0, changes, observedAt };
}

describe("deriveClaimStaleReads", () => {
  it("stales a read another holder wrote after it", () => {
    const stale = deriveClaimStaleReads(
      A,
      [read("src/auth.ts", 100)],
      [write("src/auth.ts", 200)],
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]?.staleClass).toBe("peer-write");
  });

  it("never stales a session on its own writes", () => {
    const stale = deriveClaimStaleReads(
      A,
      [read("src/auth.ts", 100)],
      [write("src/auth.ts", 200, sessionAuthor(A))],
    );
    expect(stale).toEqual([]);
  });

  it("ignores a write that happened before the read", () => {
    expect(
      deriveClaimStaleReads(
        A,
        [read("src/auth.ts", 300)],
        [write("src/auth.ts", 200)],
      ),
    ).toEqual([]);
  });

  it("ignores writes to paths the session never read", () => {
    expect(
      deriveClaimStaleReads(
        A,
        [read("src/api/route.ts", 100)],
        [write("src/ui/app.tsx", 200)],
      ),
    ).toEqual([]);
  });

  it("compares hierarchically, in both directions", () => {
    const readFile = deriveClaimStaleReads(
      A,
      [read("src/auth.ts", 100)],
      [write("src", 200)],
    );
    expect(readFile).toHaveLength(1);

    const readDirectory = deriveClaimStaleReads(
      A,
      [read("src", 100)],
      [write("src/auth.ts", 200)],
    );
    expect(readDirectory).toHaveLength(1);
  });

  it("names a hand edit as its own class (§3.4: the operator is an implicit holder)", () => {
    const stale = deriveClaimStaleReads(
      A,
      [read("src/auth.ts", 100)],
      [write("src/auth.ts", 200, humanAuthor)],
    );
    expect(stale[0]?.staleClass).toBe("hand-edit");
  });
});

describe("checkClaimContinuation", () => {
  const commitsAdded = report([
    {
      rootKey: "root",
      kind: "commits-added",
      detail: "New commits since abc.",
    },
  ]);

  it("keeps Epic 4.3's conservative verdict when the ledger is incomplete", () => {
    const gate = checkClaimContinuation(commitsAdded, {
      sessionId: A,
      complete: false,
      staleReads: [],
    });
    expect(gate.allowed).toBe(false);
    expect(gate.precise).toBe(false);
  });

  it("stops blocking on new commits the ledger can account for", () => {
    const gate = checkClaimContinuation(commitsAdded, {
      sessionId: A,
      complete: true,
      staleReads: [],
    });
    expect(gate.allowed).toBe(true);
    expect(gate.precise).toBe(true);
    expect(gate.message).toBeNull();
  });

  it("blocks when a path the session read was written by another holder", () => {
    const staleReads = deriveClaimStaleReads(
      A,
      [read("src/auth.ts", 100)],
      [write("src/auth.ts", 200)],
    );
    const gate = checkClaimContinuation(commitsAdded, {
      sessionId: A,
      complete: true,
      staleReads,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.staleReads).toHaveLength(1);
    expect(gate.message).toContain("src/auth.ts");
    expect(gate.message).toContain("sess_b");
  });

  it("blocks on a hand edit only for the paths the session read", () => {
    const uncommitted = report([
      {
        rootKey: "root",
        kind: "uncommitted-changed",
        detail: "Uncommitted changes went from 0 to 1 path(s).",
      },
    ]);

    const untouched = checkClaimContinuation(uncommitted, {
      sessionId: A,
      complete: true,
      staleReads: [],
    });
    expect(untouched.allowed).toBe(true);

    const touched = checkClaimContinuation(uncommitted, {
      sessionId: A,
      complete: true,
      staleReads: deriveClaimStaleReads(
        A,
        [read("src/auth.ts", 100)],
        [write("src/auth.ts", 200, humanAuthor)],
      ),
    });
    expect(touched.allowed).toBe(false);
    expect(touched.message).toContain("edited by hand");
  });

  it("still forces fresh on changes no ledger can speak for", () => {
    for (const kind of [
      "history-rewritten",
      "branch-changed",
      "roots-changed",
      "unknown",
    ] as const) {
      const gate = checkClaimContinuation(
        report([{ rootKey: "root", kind, detail: "d" }]),
        {
          sessionId: A,
          complete: true,
          staleReads: [],
        },
      );
      expect(gate.allowed).toBe(false);
      expect(isPathAttributable(kind)).toBe(false);
    }
  });

  it("allows continuation when nothing diverged at all", () => {
    const gate = checkClaimContinuation(report([]), {
      sessionId: A,
      complete: true,
      staleReads: [],
    });
    expect(gate.allowed).toBe(true);
    expect(gate.blocking).toEqual([]);
  });
});
