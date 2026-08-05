import { OMP_ASK_TOOL_NAME } from "@plotroom/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { RequestBridge } from "./request-bridge.js";

/**
 * `plotroom_ask` — structured questions from an omp session (§6.4), as a real
 * registered tool rather than generated source: `pi/ask-tool.ts`'s
 * `PI_ASK_TOOL_EXTENSION` was never installed in production, because pi's own
 * extension surface only accepts a tool as a string of source it evaluates
 * inside pi's process. The SDK is already this process, so the tool is
 * written once, typechecked, and registered directly.
 *
 * Same shape as the permission gate: the tool blocks on `bridge.raise`, which
 * reaches the operator through PlotRoom's request-raised/respond path (§6.4's
 * "the human's to answer"), and the answer comes back into the tool result
 * the model reads.
 *
 * **Why this tool carries no timeout.** A default that answers when one
 * expires is exactly what §14 names as a non-goal and principle 2 forbids —
 * "a timer that resumes a session is the system acting with nobody behind
 * it." `bridge.raise` has none, on purpose: it settles only when a `respond`
 * command answers it or the session ends.
 *
 * A dismissed or otherwise unanswered question returns an **error** result,
 * not a choice: the session learns that nothing was answered rather than
 * being handed one of the options nobody picked.
 */
export function createAskToolExtension(
  bridge: RequestBridge,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const parameters = pi.typebox.Type.Object({
      question: pi.typebox.Type.String({
        description: "The question, in one sentence",
      }),
      options: pi.typebox.Type.Array(pi.typebox.Type.String(), {
        description: "The choices the operator picks from; at least one",
      }),
    });

    pi.registerTool({
      name: OMP_ASK_TOOL_NAME,
      label: "Ask the operator",
      description:
        `Ask the operator a question with selectable options. Returns the ` +
        `option they picked, structurally. Use ${OMP_ASK_TOOL_NAME} when you ` +
        `need a decision only the operator can make; it blocks until they ` +
        `answer, and it never answers itself.`,
      parameters,
      approval: "read",

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const options = params.options
          .map((option) => String(option))
          .filter((option) => option.length > 0);

        if (options.length === 0) {
          return {
            content: [
              { type: "text", text: "A question needs selectable options." },
            ],
            isError: true,
          };
        }

        const outcome = await bridge.raise({
          kind: "question",
          text: params.question,
          options,
        });

        if (outcome.kind !== "answer") {
          return {
            content: [
              {
                type: "text",
                text: "The question was not answered. Nothing was chosen for you.",
              },
            ],
            isError: true,
            details: { question: params.question, options, answer: null },
          };
        }

        const answer = {
          question: params.question,
          answer: outcome.value,
          pathsNotTaken: options.filter((option) => option !== outcome.value),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(answer) }],
          details: answer,
        };
      },
    });
  };
}
