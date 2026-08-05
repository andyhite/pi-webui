import { Input, type InputProps } from "./Input.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<InputProps> = { title: "Toolkit/Input", component: Input };
export default meta;

export const Small: StoryObj<InputProps> = {
  args: { size: "sm", placeholder: "Type here…" },
};

export const Medium: StoryObj<InputProps> = {
  args: { size: "md", placeholder: "Type here…" },
};

export const Invalid: StoryObj<InputProps> = {
  args: { invalid: true, defaultValue: "bad value" },
};

export const Disabled: StoryObj<InputProps> = {
  args: { disabled: true, defaultValue: "read only" },
};
