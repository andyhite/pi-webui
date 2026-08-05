import { Badge, type BadgeProps } from "./Badge.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<BadgeProps> = { title: "Toolkit/Badge", component: Badge };
export default meta;

export const Neutral: StoryObj<BadgeProps> = {
  args: { tone: "neutral", children: "draft" },
};

export const Attention: StoryObj<BadgeProps> = {
  args: { tone: "attention", children: "needs input" },
};

export const Alert: StoryObj<BadgeProps> = {
  args: { tone: "alert", children: "failed" },
};

export const Session: StoryObj<BadgeProps> = {
  args: { tone: "session", children: "running" },
};
