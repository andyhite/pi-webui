import { Button, type ButtonProps } from "./Button.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<ButtonProps> = { title: "Toolkit/Button", component: Button };
export default meta;

export const Neutral: StoryObj<ButtonProps> = {
  args: { tone: "neutral", children: "Run" },
};

export const Attention: StoryObj<ButtonProps> = {
  args: { tone: "attention", children: "Answer" },
};

export const Alert: StoryObj<ButtonProps> = {
  args: { tone: "alert", children: "Stop" },
};

export const Small: StoryObj<ButtonProps> = {
  args: { size: "sm", children: "Run" },
};

export const Medium: StoryObj<ButtonProps> = {
  args: { size: "md", children: "Run" },
};

export const Disabled: StoryObj<ButtonProps> = {
  args: { disabled: true, children: "Run" },
};

export const Loading: StoryObj<ButtonProps> = {
  args: { loading: true, children: "Running…" },
};
