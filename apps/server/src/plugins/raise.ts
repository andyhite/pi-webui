import type {
  ApprovalAsk,
  ApprovalKind,
  ApprovalTrigger,
  ApprovalWriteExtent,
} from "@plotroom/core";
import type { PermissionRaise } from "@plotroom/plugin-sdk";

/**
 * Where a plugin's ungranted permission becomes a §6.6 approval.
 *
 * The host refuses such a call carrying a `PermissionRaise` "whose field names are
 * §6.6's own ... so the server maps this onto `ApprovalAsk` without a translation
 * table" (`docs/plugin-contract.md` §4). That claim is only worth something if
 * something checks it, and **this package is the only one that can see both types**:
 * `@plotroom/plugin-sdk` compiles against nothing, and `@plotroom/core` does not
 * depend on it either — so the compatibility is asserted here, at the seam, where a
 * drift in either vocabulary breaks the build rather than a runtime cast.
 *
 * The assertions below are the enforcement. If `ApprovalKind` ever loses
 * `tool-permission`, or `ApprovalTrigger` loses `outside-policy`, or either type's
 * field list moves, `tsc` fails on this file — which is the point: the contract is
 * frozen, and a change on the native side that silently invalidated it would leave
 * a plugin raise unroutable with nothing saying so.
 */

/** `Sub` must be assignable to `Super`, or this alias fails to compile. */
type AssertAssignable<Sub extends Super, Super> = Sub;

/**
 * The whole-shape assertion: a `PermissionRaise` **is** an `ApprovalAsk` (plus the
 * two fields naming which plugin and permission raised it, which §6.6 does not have
 * and does not need — the server carries them alongside).
 */
export type PermissionRaiseIsAnApprovalAsk = AssertAssignable<
  PermissionRaise,
  ApprovalAsk
>;

/** Field-level assertions, so a drifted enum names itself in the error. */
export type PermissionRaiseKindIsAnApprovalKind = AssertAssignable<
  PermissionRaise["kind"],
  ApprovalKind
>;
export type PermissionRaiseTriggerIsAnApprovalTrigger = AssertAssignable<
  PermissionRaise["trigger"],
  ApprovalTrigger
>;
export type PermissionRaiseExtentIsAnApprovalExtent = AssertAssignable<
  PermissionRaise["writeExtent"],
  ApprovalWriteExtent
>;

/**
 * The §6.6 ask for one ungranted permission.
 *
 * Field-for-field, because the two vocabularies are the same one: what this
 * function does is narrow a raise to exactly the ask's fields, so `pluginId` and
 * `permissionId` travel as the server's own record of *what to grant when the
 * operator says yes* rather than leaking into the ask a notification route sends.
 */
export function permissionRaiseAsk(raise: PermissionRaise): ApprovalAsk {
  return {
    kind: raise.kind,
    trigger: raise.trigger,
    tool: raise.tool,
    summary: raise.summary,
    writeExtent: raise.writeExtent,
    paths: raise.paths,
    world: raise.world,
    target: raise.target,
  };
}

/**
 * How the server finds the permission an answered approval was about.
 *
 * The approval record carries the ask, not the raise, so the plugin and permission
 * have to be recoverable from something in it. They are recoverable from the
 * **tool** name the raise sets — but only if the host set one, and a raise for a
 * non-tool contribution sets the contribution's id. So the server records the pair
 * itself, keyed by approval id, and this is only the fallback description used in
 * logs and messages.
 */
export function describeRaise(raise: PermissionRaise): string {
  return `${raise.pluginId} needs the permission ${raise.permissionId}`;
}
