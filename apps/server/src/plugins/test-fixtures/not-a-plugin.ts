/**
 * A module with no manifest at all: the load-failure corner of §10.2's isolation
 * matrix. It is reported as an install failure with a reason and **not retried** —
 * retrying a deterministic load failure is the infinite restart principle 11 rules
 * out.
 */
export const notAManifest = "this module exports no plugin";
