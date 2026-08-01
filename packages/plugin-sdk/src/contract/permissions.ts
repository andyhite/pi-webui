/**
 * Declared permissions (§10.2) and credentials (§9.3) — v1, frozen.
 *
 * "**Declared permissions:** a plugin states what it needs — network, filesystem,
 * which credentials, which core capabilities — and the user grants them; a plugin
 * cannot silently gain reach."
 *
 * Four properties, each a shape rather than a policy:
 *
 * 1. **A request names a reason**, shown verbatim on the grant surface. A reason
 *    the UI invented would be a guess about someone else's code.
 * 2. **Scope is part of the request.** `network` names hosts, `filesystem` names
 *    roots. Blanket is expressible and has to be *asked for* as blanket.
 * 3. **Credentials are named, never handed over in the contract.** A plugin
 *    requests the *use* of a credential by id; the host holds the secret and
 *    injects the value at the call boundary, for granted names only, and only into
 *    the worker — never into a tool result, a session, or another plugin (§9.3).
 *    There is no field in this contract whose value is a token.
 * 4. **Ungranted is refusal, not degradation.** {@link PermissionState} has no
 *    `"partial"` and no `"expired"`: a grant that lapsed on a timer would change
 *    what a plugin may do with nobody behind it, which is the shape principle 2
 *    rules out for spending.
 *
 * ## What the host actually enforces, stated honestly
 *
 * - **Credentials: enforced.** The worker is started with no ambient credential
 *   material; values are injected per call for granted ids the invoked
 *   contribution declared, and the host redacts any injected value that appears in
 *   a result before it leaves the host boundary.
 * - **Core capabilities: enforced.** They gate what the *host* will do with what a
 *   plugin returns; the worker is handed no function that performs one.
 * - **Network and filesystem: declarative trust in v1.** The worker runs in the
 *   host process's thread pool with Node's ordinary reach; PlotRoom records and
 *   displays these declarations and refuses ungranted *credentialed* access, but
 *   it does not yet sandbox sockets or the filesystem. Full sandboxing (a
 *   permission-model child process) is future work and is written down as such in
 *   `docs/plugin-contract.md` rather than implied to be in force.
 */
import type { CoreId, EpochMillis, PluginId } from "./ids.js";

/** Stable within a plugin; the host namespaces it by plugin id. */
export type PermissionId = string;

/**
 * What a plugin can ask for. Closed, because a permission kind the host does not
 * understand cannot be enforced, and one it cannot enforce it must refuse — an
 * open string here would make an unknown request look granted.
 */
export const PERMISSION_KINDS = [
  "network",
  "filesystem",
  "credential",
  "core-capability",
] as const;

export type PermissionKind = (typeof PERMISSION_KINDS)[number];

/**
 * The core capabilities a plugin may ask to use.
 *
 * Deliberately short, and deliberately missing the one that would matter most:
 * **there is no capability that authors a context edge.** Plugins cannot author
 * intent (principle 1, §10.2) — "a plugin produces content, offers tools, and
 * renders things; it does not draw connections between them" — so the reach does
 * not exist to be requested, granted, or added later by someone extending this
 * list. {@link CORE_CAPABILITIES} is asserted edge-free by test.
 *
 * A capability is a statement about what the **host** will do with what the plugin
 * returned. None of them is a function handed into the worker; see
 * {@link HOST_INJECTED_CAPABILITIES}.
 */
export const CORE_CAPABILITIES = [
  /** Create and update objects and versions from what a producer returned (§3.1, §9.1). */
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

export type CoreCapability = (typeof CORE_CAPABILITIES)[number];

/**
 * Everything the host injects into a worker: the complete reach a plugin has that
 * it did not bring with it.
 *
 * It is one function and one record, and the enumeration is the point (§10.2,
 * principle 1). There is **no transport in the worker**: no store handle, no HTTP
 * client to PlotRoom's API, no object writer, and above all nothing that draws a
 * context edge. A plugin's influence on the graph is the value it *returns*, which
 * the host applies under the calling session's actor.
 */
export const HOST_INJECTED_CAPABILITIES = [
  /** `context.log(message)` — a line into PlotRoom's structured log. */
  "log",
  /** `context.credentials` — granted credential values, for this call only (§9.3). */
  "credentials",
] as const;

export type HostInjectedCapability =
  (typeof HOST_INJECTED_CAPABILITIES)[number];

export type PermissionScope =
  /** Hosts it will reach. `["*"]` is expressible, and reads as blanket in the UI. */
  | { readonly kind: "network"; readonly hosts: readonly string[] }
  /** Roots it will read or write, outside the state directory (§12). */
  | {
      readonly kind: "filesystem";
      readonly roots: readonly string[];
      readonly access: "read" | "read-write";
    }
  /**
   * A credential by **id and system**, never by value: the host holds the secret
   * and injects it at the boundary (§9.3). There is no variant of this type that
   * carries one, which is the enforcement.
   */
  | {
      readonly kind: "credential";
      readonly credentialId: string;
      readonly system: string;
    }
  | { readonly kind: "core-capability"; readonly capability: CoreCapability };

export interface PermissionRequest {
  readonly id: PermissionId;
  readonly kind: PermissionKind;
  readonly scope: PermissionScope;
  /** Shown to the operator verbatim on the grant surface. Required (property 1). */
  readonly reason: string;
  /**
   * Whether the plugin can load without it. `false` means the plugin degrades to
   * partially available rather than refusing to start (§10.2) — and the host is
   * what decides that, from this declaration, so a plugin cannot make itself
   * essential.
   */
  readonly requiredToLoad: boolean;
}

/**
 * Three states, and no fourth. See property 4 above.
 *
 * `"never-asked"` is not `"denied"`: a permission nobody has answered is what the
 * runtime raise below exists for, and collapsing the two would make an unanswered
 * request indistinguishable from a refused one.
 */
export const PERMISSION_STATES = ["granted", "denied", "never-asked"] as const;

export type PermissionState = (typeof PERMISSION_STATES)[number];

export interface PermissionGrant {
  readonly pluginId: PluginId;
  readonly permissionId: PermissionId;
  readonly state: PermissionState;
  /** Null until answered. Granting is the operator's own act, always (§10.2). */
  readonly answeredAt: EpochMillis | null;
}

/* --------------------------------------------- the runtime request for a grant */

/**
 * The raise a plugin's ungranted permission produces at runtime (operator decision,
 * Epic 7.1).
 *
 * **Grants are operator-only acts** — made through the API or configuration at
 * install/enable time. When a plugin reaches for a permission nobody has answered,
 * PlotRoom does not invent a bespoke dialog: it **raises through the existing
 * approvals channel** (§6.6), which is already surfaced on every attention surface
 * and routed outbound (§7.3), answerable without opening anything.
 *
 * The field names below are §6.6's own — `kind`, `trigger`, `tool`, `summary`,
 * `writeExtent`, `paths`, `world`, `target` — so the server maps this onto
 * `ApprovalAsk` without a translation table. It is duplicated rather than imported
 * because a plugin compiles against the SDK alone; the compatibility is asserted
 * where the server wires it, and the vocabulary is frozen here.
 *
 * A raise **blocks the call**, exactly like a question: answering it is the
 * operator's, and a refusal sent alongside the raise would settle the call before
 * anybody was asked.
 */
export interface PermissionRaise {
  readonly pluginId: PluginId;
  readonly permissionId: PermissionId;
  /** §6.6's `ApprovalKind`. A plugin reaching past its grants is a capability ask. */
  readonly kind: "tool-permission";
  /** §6.6's `ApprovalTrigger`: no standing grant covers it. */
  readonly trigger: "outside-policy";
  /** The tool or host operation that reached, so the row names what for. */
  readonly tool: string | null;
  /** One line, already redacted — this goes out over a notification route (§7.3). */
  readonly summary: string;
  readonly writeExtent: "none" | "paths" | "unbounded";
  readonly paths: readonly string[];
  readonly world: null;
  readonly target: null;
}

/** Build the §6.6 raise for one ungranted permission. */
export function permissionRaise(input: {
  readonly pluginId: PluginId;
  readonly request: PermissionRequest;
  readonly tool: string | null;
}): PermissionRaise {
  const paths =
    input.request.scope.kind === "filesystem" ? input.request.scope.roots : [];
  return {
    pluginId: input.pluginId,
    permissionId: input.request.id,
    kind: "tool-permission",
    trigger: "outside-policy",
    tool: input.tool,
    summary: `${input.pluginId} needs ${describePermission(input.request)} — ${input.request.reason}`,
    writeExtent: paths.length > 0 ? "paths" : "none",
    paths,
    world: null,
    target: null,
  };
}

/** The sentence a grant surface, a queue row, and a notification all use. */
export function describePermission(request: PermissionRequest): string {
  const scope = request.scope;
  switch (scope.kind) {
    case "network":
      return scope.hosts.includes("*")
        ? "network access to any host"
        : `network access to ${scope.hosts.join(", ")}`;
    case "filesystem":
      return `${scope.access} access to ${scope.roots.join(", ")}`;
    case "credential":
      return `the ${scope.system} credential ${scope.credentialId}`;
    case "core-capability":
      return `the ${scope.capability} capability`;
  }
}

/* ----------------------------------------------------------- the actor, §10.2 */

/**
 * Who a call acts as. **The host supplies it and a plugin cannot set it**
 * (principle 1): a plugin's tool acts as the calling session, and there is no
 * field anywhere in this contract by which a plugin names an actor. It is
 * `CoreId`-typed, which a plugin cannot construct.
 */
export interface PluginActor {
  readonly sessionId: CoreId;
  readonly workstreamId: CoreId;
}
