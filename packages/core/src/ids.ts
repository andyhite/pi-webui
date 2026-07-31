/** Branded identifier types, so ids of different kinds cannot be swapped. */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkstreamId = Brand<string, "WorkstreamId">;
export type NodeId = Brand<string, "NodeId">;
export type EdgeId = Brand<string, "EdgeId">;
export type CommandId = Brand<string, "CommandId">;
export type SessionId = Brand<string, "SessionId">;
export type RunId = Brand<string, "RunId">;
export type ObjectId = Brand<string, "ObjectId">;
export type VersionId = Brand<string, "VersionId">;

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
export const newCommandId = (): CommandId => newId<"CommandId">("cmd");
export const newSessionId = (): SessionId => newId<"SessionId">("sess");
export const newRunId = (): RunId => newId<"RunId">("run");
export const newObjectId = (): ObjectId => newId<"ObjectId">("obj");
export const newVersionId = (): VersionId => newId<"VersionId">("ver");
