/**
 * The tool set a PlotRoom session runs with (issue #73's "what we turn off").
 *
 * The SDK ships far more than this and discovers more still. PlotRoom pins the
 * set explicitly instead of inheriting discovery, because two rules decide
 * membership and neither survives being left to a default:
 *
 * 1. **Nothing that spends money outside PlotRoom's accounting fold.** A
 *    subagent's cost is invisible to the parent's stats (proven in #66), so
 *    every §8 cap and every `spend_attributions` row would understate what a
 *    session cost. `task` is therefore out — and PlotRoom's fleet *is* the
 *    delegation model, so a second one beside it would be the drift principle 8
 *    exists to prevent. `security_scan` is out for the same reason: it runs its
 *    own model calls.
 * 2. **Nothing that duplicates a PlotRoom surface.** `todo` against the
 *    attention queue (§7.1), the memory and skill tools against standing
 *    instructions (§7.4) and the context graph (§3), `checkpoint`/`rewind`
 *    against versions and forks (§6.3), `hub` against steering and broadcast
 *    (§6.5). One place states a rule.
 *
 * Two more are absent for reasons of their own. `ask` is out because §6.4's
 * structured questions arrive through the gate seam, as PlotRoom's own tool
 * (issue #81) — the runtime's own prompt is not a channel PlotRoom can answer.
 * `computer` is out because desktop control has no extent a path claim can
 * bound (§3.4), and a claim ledger that cannot describe what a tool touches is
 * one that does not gate it. `lsp` is out because the session host runs with
 * `enableLsp: false`, and a tool named but unable to work is worse than an
 * absent one.
 *
 * A session may be launched narrower than this (§3.6) — never wider, which is
 * `checkToolPermissions`'s job. Widening this list is a deliberate edit here,
 * with the rule above as the argument.
 */
export const PINNED_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "ast_grep",
  "ast_edit",
  "glob",
  "grep",
  "bash",
  "eval",
  "web_search",
  "inspect_image",
];
