import { Spinner, type SpinnerProps } from "./Spinner.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<SpinnerProps> = {
  title: "Toolkit/Spinner",
  component: Spinner,
};
export default meta;

export const Small: StoryObj<SpinnerProps> = {
  args: { size: "sm", label: "Loading" },
};

export const Medium: StoryObj<SpinnerProps> = {
  args: { size: "md", label: "Loading" },
};
