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
