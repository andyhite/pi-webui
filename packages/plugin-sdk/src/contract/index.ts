/**
 * The frozen plugin contract, v1 (§10).
 *
 * Everything a plugin author compiles against lives under this directory and
 * nothing here imports `@plotroom/core`: a plugin compiles against the SDK alone.
 * See `docs/plugin-contract.md` for the prose, including what is enforced and what
 * v1 only documents.
 */
export * from "./ids.js";
export * from "./permissions.js";
export * from "./contributions.js";
export * from "./manifest.js";
export * from "./versioning.js";
