/** Branded identifier types, so ids of different kinds cannot be swapped. */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkstreamId = Brand<string, "WorkstreamId">;
export type NodeId = Brand<string, "NodeId">;
export type EdgeId = Brand<string, "EdgeId">;
/** A reusable set of marching orders (§3.5), distinct from an instance of one. */
export type CommandDefinitionId = Brand<string, "CommandDefinitionId">;
/** One command node on the graph: a definition plus its wiring (§3.5). */
export type CommandId = Brand<string, "CommandId">;
/** A command's declared output, typed and addressable before any run (§3.5). */
export type OutputId = Brand<string, "OutputId">;
export type SessionId = Brand<string, "SessionId">;
export type RunId = Brand<string, "RunId">;
export type ObjectId = Brand<string, "ObjectId">;
export type VersionId = Brand<string, "VersionId">;
/** One entry in the server's state-change stream (§2.1, §8). */
export type EventId = Brand<string, "EventId">;

/**
 * Id generation lives beside the brands so every store mints ids the same
 * way: a short kind prefix (greppable, self-describing in logs) over a v4
 * UUID. The global crypto API exists in Node and the browser alike, keeping
 * this package free of platform imports.
 */
declare const crypto: { randomUUID(): string };

function newId<T extends string>(prefix: string): Brand<string, T> {
  return `${prefix}_${crypto.randomUUID()}` as Brand<string, T>;
}

export const newWorkstreamId = (): WorkstreamId => newId<"WorkstreamId">("ws");
export const newNodeId = (): NodeId => newId<"NodeId">("node");
export const newEdgeId = (): EdgeId => newId<"EdgeId">("edge");
export const newCommandDefinitionId = (): CommandDefinitionId =>
  newId<"CommandDefinitionId">("cmddef");
export const newCommandId = (): CommandId => newId<"CommandId">("cmd");
export const newOutputId = (): OutputId => newId<"OutputId">("out");
export const newSessionId = (): SessionId => newId<"SessionId">("sess");
export const newRunId = (): RunId => newId<"RunId">("run");
export const newObjectId = (): ObjectId => newId<"ObjectId">("obj");
export const newVersionId = (): VersionId => newId<"VersionId">("ver");
export const newEventId = (): EventId => newId<"EventId">("evt");
