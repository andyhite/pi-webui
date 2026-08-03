/**
 * Declared permissions (§10.2, §9.3): what this plugin honestly needs.
 *
 * Filesystem scoping is fully runtime-configurable (§9.1) — the browse root
 * comes from `ReadRequest.scope`, decided per read, not fixed at install time
 * — and v1 has no per-plugin root-confinement mechanism to declare against
 * (`docs/plugin-contract.md` §3: "filesystem — documented, not sandboxed").
 * `roots: ["*"]` is the contract's own way to say "blanket" (the network
 * scope's doc comment states the same convention for `hosts: ["*"]"), and
 * `access: "read"` is honest: this plugin never writes.
 */
import type { PermissionRequest } from "@plotroom/plugin-sdk";

export const FS_READ_PERMISSION_ID = "fs-read";

export const FS_READ_PERMISSION: PermissionRequest = {
  id: FS_READ_PERMISSION_ID,
  kind: "filesystem",
  scope: { kind: "filesystem", roots: ["*"], access: "read" },
  reason:
    "read file and directory contents at the path configured for browsing, so files and directories can be produced as document concepts (§9.4)",
  requiredToLoad: false,
};
