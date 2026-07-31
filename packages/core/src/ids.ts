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
