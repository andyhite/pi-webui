import { Banner, type BannerProps } from "./Banner.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<BannerProps> = { title: "Toolkit/Banner", component: Banner };
export default meta;

export const Neutral: StoryObj<BannerProps> = {
  args: { tone: "neutral", children: "Workspace synced." },
};

export const NeutralDismissible: StoryObj<BannerProps> = {
  args: {
    tone: "neutral",
    children: "Workspace synced.",
    onDismiss: () => {},
  },
};

export const Attention: StoryObj<BannerProps> = {
  args: {
    tone: "attention",
    children: "Three nodes need your answer before the run can continue.",
  },
};

export const AttentionDismissible: StoryObj<BannerProps> = {
  args: {
    tone: "attention",
    children: "Three nodes need your answer before the run can continue.",
    onDismiss: () => {},
  },
};

export const Alert: StoryObj<BannerProps> = {
  args: {
    tone: "alert",
    children: "Run stopped — upstream provider refused the request.",
  },
};

export const AlertDismissible: StoryObj<BannerProps> = {
  args: {
    tone: "alert",
    children: "Run stopped — upstream provider refused the request.",
    onDismiss: () => {},
  },
};
