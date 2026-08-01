import {
  ConnectionRefused,
  EntityNotFound,
  LifecycleRefused,
  PublishRefused,
  RunRefused,
  ScopeRefused,
} from "@plotroom/db";
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
    err instanceof LifecycleRefused ||
    err instanceof PublishRefused ||
    err instanceof RunRefused
  ) {
    return refused(err.refusal);
  }

  return null;
}
