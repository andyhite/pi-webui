import { Field } from "./Field.js";
import { Select, type SelectProps } from "./Select.js";
import type { Meta, StoryObj } from "./story-kit.js";

const OPTIONS = [
  { value: "sonnet", label: "Claude Sonnet" },
  { value: "opus", label: "Claude Opus" },
  { value: "haiku", label: "Claude Haiku" },
] as const;

const meta: Meta<SelectProps> = { title: "Toolkit/Select", component: Select };
export default meta;

export const Small: StoryObj<SelectProps> = {
  args: { size: "sm", options: OPTIONS, defaultValue: "sonnet" },
};

export const Medium: StoryObj<SelectProps> = {
  args: { size: "md", options: OPTIONS, defaultValue: "sonnet" },
};

export const Invalid: StoryObj<SelectProps> = {
  args: { invalid: true, options: OPTIONS, defaultValue: "sonnet" },
};

export const Disabled: StoryObj<SelectProps> = {
  args: { disabled: true, options: OPTIONS, defaultValue: "sonnet" },
};

export const WithField: StoryObj<SelectProps> = {
  args: { options: OPTIONS, defaultValue: "sonnet" },
  render: () => (
    <Field label="Model" hint="Choose which model to run.">
      <Select options={OPTIONS} defaultValue="sonnet" />
    </Field>
  ),
};
