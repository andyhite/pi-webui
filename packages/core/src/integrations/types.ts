/**
 * The integration substrate's own vocabulary (Epic 7.2, §9.1–§9.3).
 *
 * `packages/plugin-sdk/src/contract/` is the frozen v1 plugin contract
 * (`docs/plugin-contract.md`) — built against its draft predecessor, which this
 * batch reconciled at rebase. This module is the native counterpart the
 * contract's `ConceptProducer` / `RefreshMode` / `ScopingDeclaration` point at:
 * `@plotroom/core` cannot depend on `@plotroom/plugin-sdk` (the dependency runs
 * the other way, contract → nothing, eventually host → core), so the shapes
 * are mirrored here rather than imported, and
 * `apps/server/src/integrations/registry.ts` is where the two vocabularies meet.
 *
 * Three rules carried over from the draft, restated because they are the ones a
 * server-side implementation could quietly violate:
 *
 * 1. **Scheduled reads only, never scheduled runs** (principle 2, §9.1). Nothing
 *    in this module can start a session; {@link isIntervalRefreshDue} answers
 *    "is a read due", never "run something".
 * 2. **Concepts are present-or-absent, never degraded** (§3.1). A broken
 *    connection does not remove what was last read; see
 *    `attention/health.ts`'s `integrationBrokenAlerts` for the health-not-data
 *    half of that rule.
 * 3. **Reversibility is not optional** (§9.2, §6.6). Every declared write action
 *    carries `WriteReversibility` from `sessions/outside-world.ts` — the exact
 *    declaration §6.6's piercing rule and §6.3's outside-world markers already
 *    read from.
 */

import type { WriteReversibility } from "../sessions/outside-world.js";

/** Mirrors the contract's `RefreshMode` (§9.1): reads only, never runs (principle 2). */
export type IntegrationRefreshMode =
  | { readonly kind: "on-demand" }
  | { readonly kind: "interval"; readonly seconds: number }
  /** The plugin observes something and tells the host; still a read. */
  | { readonly kind: "observed"; readonly what: string };

/** Mirrors the contract's `ScopingDeclaration` (§9.1): the source's own query language. */
export interface IntegrationScopingDeclaration {
  readonly language: string;
  readonly example: string;
}

/**
 * Connection state (§9.3), visible rather than inferred.
 *
 * `"broken"` is reached only by an observed failure (an auth error on a refresh),
 * never assumed from silence — silence is `"connected"` until something says
 * otherwise, because guessing "broken" from the absence of a recent success would
 * be exactly the inference principle 7 rules out.
 */
export const INTEGRATION_CONNECTION_STATES = [
  "connected",
  "disconnected",
  "broken",
] as const;

export type IntegrationConnectionState =
  (typeof INTEGRATION_CONNECTION_STATES)[number];

/**
 * One integration instance: a connected use of a plugin's concept producer
 * (§9.1, §9.3).
 *
 * `scope` is opaque here on purpose — "the source's own query language,
 * runtime-configurable" (§9.1) means the substrate stores and forwards a string
 * it never parses; the producer is what understands it.
 */
export interface Integration {
  readonly id: string;
  readonly pluginId: string;
  readonly producerId: string;
  readonly name: string;
  readonly system: string;
  readonly scope: string | null;
  readonly connectionState: IntegrationConnectionState;
  readonly lastConnectedAt: number | null;
  readonly lastRefreshAt: number | null;
  readonly lastBrokenAt: number | null;
  readonly lastBrokenReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A declared write action, as the substrate's write-gate seam needs it — the
 * subset of the contract's `WriteAction` that `toolCallAsk`/`decideApproval` are
 * built to consume (§9.2, §6.6). `perform`/`input` stay with the registry
 * (`apps/server/src/integrations/registry.ts`); this is only what an approval ask
 * has to carry.
 */
export interface IntegrationWriteActionDeclaration {
  readonly id: string;
  readonly action: string;
  readonly system: string;
  readonly reversibility: WriteReversibility;
}
