import { Box } from "./Box.js";
import { Stack, type StackProps } from "./Stack.js";
import type { Meta, StoryObj } from "./story-kit.js";

const item = (
  <Box border="hair" padding={3}>
    item
  </Box>
);

const meta: Meta<StackProps> = { title: "Toolkit/Stack", component: Stack };
export default meta;

export const Row: StoryObj<StackProps> = {
  args: { direction: "row", gap: 3 },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
      {item}
    </Stack>
  ),
};

export const Column: StoryObj<StackProps> = {
  args: { direction: "column", gap: 3 },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
      {item}
    </Stack>
  ),
};

export const JustifyBetween: StoryObj<StackProps> = {
  args: { direction: "row", justify: "between" },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
    </Stack>
  ),
};

export const AlignCenter: StoryObj<StackProps> = {
  args: { direction: "row", align: "center", gap: 3 },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
    </Stack>
  ),
};

export const Wrap: StoryObj<StackProps> = {
  args: { direction: "row", wrap: true, gap: 3 },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
      {item}
    </Stack>
  ),
};

export const AlignStart: StoryObj<StackProps> = {
  args: { direction: "row", align: "start", gap: 3 },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
    </Stack>
  ),
};

export const AlignEnd: StoryObj<StackProps> = {
  args: { direction: "row", align: "end", gap: 3 },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
    </Stack>
  ),
};

export const AlignStretch: StoryObj<StackProps> = {
  args: { direction: "row", align: "stretch", gap: 3 },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
    </Stack>
  ),
};

export const AlignBaseline: StoryObj<StackProps> = {
  args: { direction: "row", align: "baseline", gap: 3 },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
    </Stack>
  ),
};

export const JustifyStart: StoryObj<StackProps> = {
  args: { direction: "row", justify: "start" },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
    </Stack>
  ),
};

export const JustifyCenter: StoryObj<StackProps> = {
  args: { direction: "row", justify: "center" },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
    </Stack>
  ),
};

export const JustifyEnd: StoryObj<StackProps> = {
  args: { direction: "row", justify: "end" },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
    </Stack>
  ),
};

export const JustifyAround: StoryObj<StackProps> = {
  args: { direction: "row", justify: "around" },
  render: (args) => (
    <Stack {...args}>
      {item}
      {item}
    </Stack>
  ),
};
