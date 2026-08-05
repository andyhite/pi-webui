import { Box, type BoxProps } from "./Box.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<BoxProps> = { title: "Toolkit/Box", component: Box };
export default meta;

export const Panel: StoryObj<BoxProps> = {
  args: { surface: "panel", radius: "block", padding: 6, children: "panel" },
};

export const Well: StoryObj<BoxProps> = {
  args: { surface: "well", radius: "control", padding: 4, children: "well" },
};

export const Footer: StoryObj<BoxProps> = {
  args: { surface: "footer", radius: "block", padding: 4, children: "footer" },
};

export const Chrome: StoryObj<BoxProps> = {
  args: { surface: "chrome", radius: "block", padding: 4, children: "chrome" },
};

export const HairBorder: StoryObj<BoxProps> = {
  args: { border: "hair", padding: 4, children: "hair" },
};

export const SoftBorder: StoryObj<BoxProps> = {
  args: { border: "soft", padding: 4, children: "soft" },
};

export const EdgeBorder: StoryObj<BoxProps> = {
  args: { border: "edge", padding: 4, children: "edge" },
};

export const StrongBorder: StoryObj<BoxProps> = {
  args: { border: "strong", padding: 4, children: "strong" },
};

export const PerSidePadding: StoryObj<BoxProps> = {
  args: {
    paddingTop: 1,
    paddingRight: 6,
    paddingBottom: 12,
    paddingLeft: 3,
    border: "hair",
    children: "per-side padding",
  },
};
