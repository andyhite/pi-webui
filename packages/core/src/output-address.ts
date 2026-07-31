import type { CommandId, RunId } from "./ids.js";

/**
 * Spec §15 invariant 4: outputs are addressed per run. `latest` is one case of
 * a general address, never the only case — a system built on "the output"
 * cannot grow run comparison later (§4.4).
 */
export type OutputAddress =
  | {
      readonly commandId: CommandId;
      readonly name: string;
      readonly at: "latest";
    }
  | {
      readonly commandId: CommandId;
      readonly name: string;
      readonly at: "pinned";
      readonly runId: RunId;
    }
  | {
      readonly commandId: CommandId;
      readonly name: string;
      readonly at: "run";
      readonly runId: RunId;
    };

export function formatOutputAddress(address: OutputAddress): string {
  switch (address.at) {
    case "latest":
      return `${address.commandId}/${address.name}@latest`;
    case "pinned":
    case "run":
      return `${address.commandId}/${address.name}@${address.runId}`;
  }
}
