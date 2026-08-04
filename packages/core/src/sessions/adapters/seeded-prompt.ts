import type { RuntimeStartConfig } from "../runtime.js";

/**
 * A fork seeded from PlotRoom's own transcript (§6.3). The inheritance is
 * labelled: a seeded fork is not a native one, and pretending otherwise is the
 * fidelity risk decision 0001 names.
 *
 * Shared by every adapter, because `planFork`'s seeded verdict must produce the
 * same session whichever runtime carries it out.
 */
export function composeSeededPrompt(config: RuntimeStartConfig): string {
  if (!config.seedTranscript) return config.prompt;
  return [
    "# Inherited transcript",
    "",
    "This session was forked from an earlier one. What follows is the",
    "conversation up to the fork point, as PlotRoom recorded it.",
    "",
    config.seedTranscript,
    "",
    "# Continue from here",
    "",
    config.prompt,
  ].join("\n");
}
