/**
 * One consistent error shape (Epic 2.1) for every failure the API returns —
 * agents parse errors too (principle 8), so there is exactly one shape to
 * parse, never a route-specific ad hoc body.
 */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export function notFound(message = "not found"): ApiError {
  return new ApiError(404, "not_found", message);
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, "bad_request", message, details);
}

export function unauthorized(message: string): ApiError {
  return new ApiError(401, "unauthorized", message);
}

export function forbidden(message: string): ApiError {
  return new ApiError(403, "forbidden", message);
}

/**
 * What a predicate said, verbatim (Epic 2.2, principles 1 and 8).
 *
 * A refusal is not a malformed request and never an internal error: the
 * request was understood and the rules said no. `reason` is the predicate's
 * own machine-readable reason — `would_cycle`, `own_chain`,
 * `session_not_running` — so an agent branches on exactly the value the
 * canvas shows mid-drag, and the two surfaces cannot drift apart.
 */
export interface Refusal {
  readonly reason: string;
  readonly message: string;
}

export function refused(refusal: Refusal): ApiError {
  return new ApiError(409, "refused", refusal.message, {
    reason: refusal.reason,
  });
}
