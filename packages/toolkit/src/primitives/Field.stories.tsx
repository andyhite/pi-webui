import { Field, type FieldProps } from "./Field.js";
import { Input } from "./Input.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<FieldProps> = { title: "Toolkit/Field", component: Field };
export default meta;

export const Default: StoryObj<FieldProps> = {
  args: {
    label: "Name",
    children: <Input placeholder="Ada Lovelace" />,
  },
};

export const Hint: StoryObj<FieldProps> = {
  args: {
    label: "API key",
    hint: "Found in your account settings.",
    children: <Input type="password" placeholder="sk-…" />,
  },
};

export const Error: StoryObj<FieldProps> = {
  args: {
    label: "Email",
    error: "Enter a valid email address.",
    children: <Input type="email" defaultValue="not-an-email" />,
  },
};

export const Required: StoryObj<FieldProps> = {
  args: {
    label: "Project name",
    required: true,
    children: <Input placeholder="my-project" />,
  },
};
