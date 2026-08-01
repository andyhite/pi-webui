/**
 * Workspace identifiers.
 *
 * The brands live here rather than in `src/ids.ts` because the workspaces
 * subtree is owned separately (development plan, "Tracks and timeline"); the
 * technique is the one `src/ids.ts` established — a nominal brand so ids of
 * different kinds cannot be swapped, and a short greppable prefix over a v4
 * UUID.
 */

declare const workspaceBrand: unique symbol;

type Brand<T, B extends string> = T & { readonly [workspaceBrand]: B };

/** One workstream's workspace (§3.4). */
export type WorkspaceId = Brand<string, "WorkspaceId">;
/** A repository the product knows about, discovered or declared (§3.4). */
export type RepositoryId = Brand<string, "RepositoryId">;
/** One attempt at the declared setup step, so its output stays addressable (§3.4). */
export type SetupAttemptId = Brand<string, "SetupAttemptId">;

declare const crypto: { randomUUID(): string };

function newId<T extends string>(prefix: string): Brand<string, T> {
  return `${prefix}_${crypto.randomUUID()}` as Brand<string, T>;
}

export const newWorkspaceId = (): WorkspaceId => newId<"WorkspaceId">("wsp");
export const newRepositoryId = (): RepositoryId =>
  newId<"RepositoryId">("repo");
export const newSetupAttemptId = (): SetupAttemptId =>
  newId<"SetupAttemptId">("setup");
