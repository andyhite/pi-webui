import { Toast, type ToastProps } from "./Toast.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<ToastProps> = { title: "Toolkit/Toast", component: Toast };
export default meta;

export const Neutral: StoryObj<ToastProps> = {
  args: { tone: "neutral", children: "Copied node id to clipboard." },
};

export const Attention: StoryObj<ToastProps> = {
  args: {
    tone: "attention",
    children: "New question arrived — open the conversation panel to answer.",
  },
};

export const Alert: StoryObj<ToastProps> = {
  args: { tone: "alert", children: "Could not save layout — try again." },
};
