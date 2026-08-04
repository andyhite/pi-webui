/**
 * Structured logs (spec §8): one consistent shape across the server, level
 * adjustable at runtime — not by restart — and sensitive values redacted.
 *
 * Each line is one JSON object: `{ time, level, msg, ...fields }`. Written to
 * stdout so any process supervisor or `plotroom logs | jq` sees the same
 * shape; the in-app Logs panel (Epic 8.3) reads the same stream.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Exported so the ring buffer (Epic 8.3) can filter "at least this level" the same way. */
export const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Field names redacted wherever they appear, however deeply nested. */
const SENSITIVE_KEYS = new Set([
  "credential",
  "authorization",
  "authorizationheader",
  "password",
  "secret",
  "token",
]);

const REDACTED = "[redacted]";

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(val),
      ]),
    );
  }
  return value;
}

export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

/**
 * Level is a mutable field on the instance, not a constructor argument that
 * would need a restart to change — `setLevel` is what the runtime-adjustable
 * requirement (§8) calls into, whether the caller is a signal handler or the
 * `/api/log-level` endpoint.
 */
export class Logger {
  #level: LogLevel;
  readonly #sink: LogSink;
  readonly #clock: () => string;

  constructor(
    level: LogLevel = "info",
    sink: LogSink = (line) => process.stdout.write(line + "\n"),
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.#level = level;
    this.#sink = sink;
    this.#clock = clock;
  }

  get level(): LogLevel {
    return this.#level;
  }

  setLevel(level: LogLevel): void {
    this.#level = level;
  }

  #log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#level]) return;
    const entry = {
      time: this.#clock(),
      level,
      msg,
      ...(fields ? (redact(fields) as LogFields) : {}),
    };
    this.#sink(JSON.stringify(entry));
  }

  debug(msg: string, fields?: LogFields): void {
    this.#log("debug", msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.#log("info", msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.#log("warn", msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.#log("error", msg, fields);
  }

  /**
   * A logger that tags every line with `component` (Epic 8.3's log query
   * filter). Not a second `Logger` instance — there is exactly one level to
   * adjust at runtime, and a child with its own `#level` would be a second
   * one nothing keeps in sync — just this same logger's own methods with one
   * field pre-filled, exactly like every call site already passes fields.
   */
  child(component: string): ComponentLogger {
    return {
      debug: (msg, fields) => this.debug(msg, { component, ...fields }),
      info: (msg, fields) => this.info(msg, { component, ...fields }),
      warn: (msg, fields) => this.warn(msg, { component, ...fields }),
      error: (msg, fields) => this.error(msg, { component, ...fields }),
    };
  }
}

export interface ComponentLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}
