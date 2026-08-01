/**
 * Identifiers as the plugin contract sees them (v1, frozen).
 *
 * `@plotroom/core` brands its ids, and this package does not depend on core: a
 * plugin compiles against the SDK alone. The draft left ids as bare `string` and
 * recorded that the freeze would make them opaque; this is that. A plugin
 * **receives** core ids and hands them back; it never constructs one, so the brand
 * costs a plugin author nothing and makes "the host owns identity" a type rule
 * rather than a convention.
 *
 * A plugin's own ids — its plugin id, its contribution ids, an external system's
 * id — are plain strings, because a plugin does construct those.
 */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * An id minted by PlotRoom, opaque to the plugin: a session, a workstream, an
 * object. The host validates it at the boundary — a plugin cannot produce one and
 * therefore cannot name a record it was not given.
 */
export type CoreId = Brand<string, "CoreId">;

/** A plugin's own id, unique across installed plugins. The host namespaces by it. */
export type PluginId = string;

/** Stable within a plugin: the id of one contribution. */
export type ContributionId = string;

/** Milliseconds since the epoch, matching PlotRoom's observation vocabulary. */
export type EpochMillis = number;
