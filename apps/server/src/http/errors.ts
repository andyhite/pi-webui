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
