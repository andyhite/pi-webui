/**
 * DRAFT — the declared-permissions model (§10.2). **Unstable; wired to nothing.**
 *
 * "**Declared permissions:** a plugin states what it needs — network, filesystem,
 * which credentials, which core capabilities — and the user grants them; a plugin
 * cannot silently gain reach."
 *
 * Four properties this sketch is built to make true, each of which is a shape rather
 * than a policy:
 *
 * 1. **A request names a reason.** The grant surface has to show the user *why*, and
 *    a reason invented by the UI would be a guess about someone else's code. So
 *    `reason` is required on the request, and a plugin that cannot say why it needs
 *    the network has not finished asking.
 * 2. **Scope is part of the request, not a footnote.** `network` names hosts and
 *    `filesystem` names roots. A blanket "network" grant is expressible (some
 *    plugins genuinely need it) but it has to be *asked for* as blanket, so the
 *    grant surface can say so in those words.
 * 3. **Credentials are named, never handed over.** A plugin requests the *use* of a
 *    credential by id; the host holds the secret and injects it at the call
 *    boundary. There is no field anywhere in this contract whose value is a token,
 *    which is what "credentials are stored by the app and exposed to no session and
 *    no other plugin" (§9.3) means in a type.
 * 4. **Ungranted is refusal, not degradation.** `DraftPermissionState` has no
 *    "partial": a capability is granted or it is not, and a plugin operating on half
 *    a grant is the silent reach §10.2 rules out. What degrades is the *plugin*,
 *    reported as unavailable or misconfigured — never the data (§3.1, §9.3).
 *
 * ## OPEN OPERATOR DECISION — the permission-grant UX
 *
 * AGENTS.md lists "Plugin distribution and permission-grant UX" as an open
 * decision, and it is **still open**: nothing here decides it, and nothing here
 * should be read as deciding it. The questions that need an answer before Epic 7.1
 * freezes, stated so they can be answered rather than discovered:
 *
 * - **When is the grant asked for?** At install (one dialog, everything up front) or
 *   at first use (in context, but a plugin that needs the network to load cannot
 *   start)? A hybrid — install-time for load-time needs, first-use for the rest —
 *   is a third option and costs two surfaces.
 * - **Is a grant revocable while a plugin is enabled**, and if so, what does the
 *   plugin see? An error, or the capability simply absent?
 * - **What happens when an update widens the request?** Refuse and keep the old
 *   version, run degraded, or ask again — with the constraint that a plugin update
 *   must never silently gain reach (§10.2).
 * - **Does a granted permission travel with the state directory?** The store is the
 *   unit of backup and movement (§12); a grant that moved with it means a copied
 *   store carries capability, and a grant that did not means every move re-asks.
 * - **Is there a "trusted publisher" tier**, or is every plugin asked about
 *   identically? The in-box four are the interesting case: they ship with the
 *   product and are not obviously the user's decision to make.
 *
 * Recorded here rather than resolved, because a permission UX invented by an
 * implementation is a permission UX nobody reviewed.
 */

/** DRAFT. Stable within a plugin; the host namespaces it by plugin name. */
export type DraftPermissionId = string;

/**
 * DRAFT. What a plugin can ask for. Closed, because a permission kind the host does
 * not understand cannot be enforced, and one it cannot enforce it must refuse — an
 * open string here would make an unknown request look granted.
 */
export const DRAFT_PERMISSION_KINDS = [
  "network",
  "filesystem",
  "credential",
  "core-capability",
] as const;

export type DraftPermissionKind = (typeof DRAFT_PERMISSION_KINDS)[number];

/**
 * DRAFT. The core capabilities a plugin may ask to use.
 *
 * Deliberately short, and deliberately missing the one thing that would matter
 * most: **there is no capability that authors a context edge.** Plugins cannot
 * author intent (principle 1, §10.2) — "a plugin produces content, offers tools,
 * and renders things; it does not draw connections between them" — so the reach does
 * not exist to be requested, granted, or accidentally added later by someone
 * extending this list.
 */
export const DRAFT_CORE_CAPABILITIES = [
  /** Create and update objects and versions it produced (§3.1, §9.1). */
  "write-objects",
  /** Read objects, so a renderer or a check can see what it is rendering. */
  "read-objects",
  /** Offer agent tools, which act as the calling session (principle 1). */
  "agent-tools",
  /** Provision and release workspaces of a kind it contributes (§3.4). */
  "workspaces",
  /** Send on an outbound notification route with a host-redacted payload (§7.3). */
  "notify",
] as const;

export type DraftCoreCapability = (typeof DRAFT_CORE_CAPABILITIES)[number];

export type DraftPermissionScope =
  /** Hosts it will reach. `["*"]` is expressible, and reads as blanket in the UI. */
  | { readonly kind: "network"; readonly hosts: readonly string[] }
  /** Roots it will read or write, outside the state directory (§12). */
  | {
      readonly kind: "filesystem";
      readonly roots: readonly string[];
      readonly access: "read" | "read-write";
    }
  /**
   * A credential by **id and shape**, never by value: the host holds the secret and
   * injects it at the boundary (§9.3). There is no variant of this type that carries
   * one, which is the enforcement.
   */
  | {
      readonly kind: "credential";
      readonly credentialId: string;
      readonly system: string;
    }
  | {
      readonly kind: "core-capability";
      readonly capability: DraftCoreCapability;
    };

export interface DraftPermissionRequest {
  readonly id: DraftPermissionId;
  readonly kind: DraftPermissionKind;
  readonly scope: DraftPermissionScope;
  /** Shown to the user verbatim on the grant surface. Required (see property 1). */
  readonly reason: string;
  /**
   * Whether the plugin can load without it. `false` means the plugin degrades to
   * partially available rather than refusing to start (§10.2) — and the host is what
   * decides that, from this declaration, so a plugin cannot make itself essential.
   */
  readonly requiredToLoad: boolean;
}

/**
 * DRAFT. Three states, and no fourth: `"granted"`, `"denied"`, and
 * `"never-asked"`. There is no `"partial"` and no `"expired"` — a grant that lapsed
 * on a timer would change what a plugin may do with nobody behind it, which is the
 * same shape principle 2 rules out for spending.
 */
export const DRAFT_PERMISSION_STATES = [
  "granted",
  "denied",
  "never-asked",
] as const;

export type DraftPermissionState = (typeof DRAFT_PERMISSION_STATES)[number];

export interface DraftPermissionGrant {
  readonly permissionId: DraftPermissionId;
  readonly state: DraftPermissionState;
  /** Null until it is answered; the operator's own act, always (§10.2). */
  readonly answeredAt: number | null;
}
