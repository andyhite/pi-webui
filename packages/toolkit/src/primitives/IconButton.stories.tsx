import { IconButton, type IconButtonProps } from "./IconButton.js";
import type { Meta, StoryObj } from "./story-kit.js";

// A minimal glyph: the stories exercise the control, not an icon set (#102
// names no icon library, and the primitive accepts any `ReactNode`).
const dot = <span aria-hidden="true">●</span>;

const meta: Meta<IconButtonProps> = {
  title: "Toolkit/IconButton",
  component: IconButton,
};
export default meta;

export const Neutral: StoryObj<IconButtonProps> = {
  args: { tone: "neutral", "aria-label": "Stop session", children: dot },
};

export const Attention: StoryObj<IconButtonProps> = {
  args: { tone: "attention", "aria-label": "Answer question", children: dot },
};

export const Alert: StoryObj<IconButtonProps> = {
  args: { tone: "alert", "aria-label": "Delete node", children: dot },
};

export const Small: StoryObj<IconButtonProps> = {
  args: { size: "sm", "aria-label": "Stop session", children: dot },
};

export const Medium: StoryObj<IconButtonProps> = {
  args: { size: "md", "aria-label": "Stop session", children: dot },
};

export const Disabled: StoryObj<IconButtonProps> = {
  args: { disabled: true, "aria-label": "Stop session", children: dot },
};

export const Loading: StoryObj<IconButtonProps> = {
  args: { loading: true, "aria-label": "Stop session", children: dot },
};
