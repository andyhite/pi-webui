import type { CommandId, RunId } from "./ids.js";

/**
 * Spec §15 invariant 4: outputs are addressed per run. `latest` is one case of
 * a general address, never the only case — a system built on "the output"
 * cannot grow run comparison later (§4.4).
 *
 * `output@n` — the run's ordinal within its command — is the general form the
 * spec names. `latest` is written as its own variant because it is what the
 * user types, but it is *resolved* by ordering runs, never stored: nothing in
 * the schema records which run is latest.
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
      readonly at: "ordinal";
      /** The `n` in `output@n`: 1-based, per command. */
      readonly runOrdinal: number;
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
    case "ordinal":
      return `${address.commandId}/${address.name}@${address.runOrdinal}`;
    case "pinned":
    case "run":
      return `${address.commandId}/${address.name}@${address.runId}`;
  }
}
