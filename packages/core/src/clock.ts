/**
 * Time as a dependency (Epic 1.0). Stores never read the wall clock directly:
 * retention windows, drift baselines, and idempotency are untestable against
 * real time, so every store takes a Clock and production passes systemClock.
 */
export type Clock = () => number;

/** Unix seconds, matching every created_at column in the schema. */
export const systemClock: Clock = () => Math.floor(Date.now() / 1000);
