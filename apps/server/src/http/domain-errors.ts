import {
  ConnectionRefused,
  EntityNotFound,
  LifecycleRefused,
  PlacementRefused,
  PublishRefused,
  RunRefused,
  ScopeRefused,
  WorkspaceRefused,
} from "@plotroom/db";
import { SessionHostNotReady, SessionHostSilent } from "@plotroom/core";
import { ApiError, notFound, refused } from "./errors.js";

/**
 * The one place a domain refusal becomes an HTTP response (Epic 2.2).
 *
 * The rules live in `@plotroom/core` as predicates and the stores call them;
 * the API's job is to report what they said, not to restate it. Every store
 * refusal carries a `refusal` — the predicate's own reason and message — so
 * this maps a class to a status and passes the reason through untouched.
 *
 * Two things it deliberately guarantees: a refusal is a 4xx with its reason
 * attached, never a 500 and never a silent no-op; and an id that names
 * nothing is a 404, matched on {@link EntityNotFound} rather than on the
 * wording of a message.
 */
export function toApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (err instanceof EntityNotFound) return notFound(err.message);

  if (
    err instanceof ConnectionRefused ||
    err instanceof ScopeRefused ||
    err instanceof PlacementRefused ||
    err instanceof LifecycleRefused ||
    err instanceof PublishRefused ||
    err instanceof RunRefused ||
    // The readiness gate and the workspace boundary refuse the same way: with
    // the predicate's own visible reason (§3.4).
    err instanceof WorkspaceRefused
  ) {
    return refused(err.refusal);
  }

  // A runtime that would not start is a refused run, not a broken server: the
  // reason is a sentence about a live process the operator can look at, and
  // answering 500 `internal_error` would throw it away (issue #108). These two
  // are the adapter's own, so they carry no `refusal` of their own to pass on.
  if (err instanceof SessionHostNotReady || err instanceof SessionHostSilent) {
    return refused({ reason: "runtime_would_not_start", message: err.message });
  }

  return null;
}
