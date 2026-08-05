import { Button } from "./Button.js";
import { Tooltip, type TooltipProps } from "./Tooltip.js";
import type { Meta, StoryObj } from "./story-kit.js";

const trigger = <Button>Trigger</Button>;

const meta: Meta<TooltipProps> = {
  title: "Toolkit/Tooltip",
  component: Tooltip,
};
export default meta;

export const OpenOnHover: StoryObj<TooltipProps> = {
  args: { content: "Opens when you hover the trigger", children: trigger },
  render: (args) => (
    <Tooltip {...args}>
      <Button>Hover me</Button>
    </Tooltip>
  ),
};

/**
 * `autoFocus` on the trigger so the tooltip is visible without a pointer —
 * documents keyboard reachability (WAI-ARIA tooltip on focus).
 */
export const OpenOnFocus: StoryObj<TooltipProps> = {
  args: { content: "Opens when the trigger has focus", children: trigger },
  render: (args) => (
    <Tooltip {...args}>
      <Button autoFocus>Focused trigger</Button>
    </Tooltip>
  ),
};
