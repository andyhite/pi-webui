import { PI_QUESTION_TITLE_PREFIX } from "./permission-gate.js";

/**
 * `plotroom_ask` — structured questions from a pi session (§6.4).
 *
 * The same shape as the permission gate and as `plotroom_submit_outcome`: a tool
 * the extension exposes, whose implementation asks *PlotRoom* and blocks until
 * PlotRoom answers. In RPC mode `ctx.ui.select` becomes an `extension_ui_request`
 * on stdout and blocks until an `extension_ui_response` arrives, so the question
 * reaches the operator's bubble (§5) and the answer comes back into the tool
 * result the model reads. `parseGateRequest` recognises it by the title prefix
 * and maps it to a `request-raised` observation, so the question is part of the
 * observation log like everything else.
 *
 * ## Why this tool carries no timeout
 *
 * pi's dialogs accept one: `ctx.ui.select(title, options, { timeout })`
 * auto-resolves with `undefined` when it expires. Using it would be a timed
 * default, which §14 names as a non-goal and principle 2 forbids — "a timer that
 * resumes a session is the system acting with nobody behind it". So the generated
 * source below passes no options object at all, and `adapter.test.ts` asserts
 * the string contains no timer of any kind. A prohibition in a comment is a
 * prohibition someone edits out; this one fails a test.
 *
 * A dismissed question returns an **error** result, not a choice: the session
 * learns that nothing was answered rather than being handed one of the options
 * nobody picked.
 */
export const PI_ASK_TOOL_NAME = "plotroom_ask";

export const PI_ASK_TOOL_EXTENSION = `/**
 * PlotRoom structured questions — generated, do not edit.
 *
 * Asks the operator through PlotRoom and returns the answer structurally (§6.4).
 * No timer of any kind appears below, deliberately: no question may carry a
 * default that proceeds when one expires (§14, principle 2). The adapter's test
 * suite asserts that over this string.
 */
export default function (pi) {
  pi.registerTool({
    name: "${PI_ASK_TOOL_NAME}",
    label: "Ask the operator",
    description:
      "Ask the operator a question with selectable options. Returns the option they picked, structurally. Use ${PI_ASK_TOOL_NAME} when you need a decision only the operator can make; it blocks until they answer, and it never answers itself.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in one sentence" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "The choices the operator picks from; at least one",
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const options = (params.options ?? [])
        .map((option) => String(option))
        .filter((option) => option.length > 0);

      if (options.length === 0) {
        return {
          content: [{ type: "text", text: "A question needs selectable options." }],
          isError: true,
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [
            { type: "text", text: "PlotRoom is not attached, so nobody can answer." },
          ],
          isError: true,
        };
      }

      const picked = await ctx.ui.select(
        "${PI_QUESTION_TITLE_PREFIX}" + params.question,
        options,
      );

      if (picked === undefined) {
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
        answer: picked,
        pathsNotTaken: options.filter((option) => option !== picked),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(answer) }],
        details: answer,
      };
    },
  });
}
`;
