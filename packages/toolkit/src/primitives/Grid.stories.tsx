import { Box } from "./Box.js";
import { Grid, type GridProps } from "./Grid.js";
import type { Meta, StoryObj } from "./story-kit.js";

const cell = (
  <Box border="hair" padding={3}>
    cell
  </Box>
);

const meta: Meta<GridProps> = { title: "Toolkit/Grid", component: Grid };
export default meta;

export const ColumnCount: StoryObj<GridProps> = {
  args: { columns: 3, gap: 3 },
  render: (args) => (
    <Grid {...args}>
      {cell}
      {cell}
      {cell}
    </Grid>
  ),
};

export const TrackList: StoryObj<GridProps> = {
  // §08's region row: a fixed key column plus a fluid value column.
  args: { columns: "var(--pr-region-key-w) 1fr", columnGap: 5 },
  render: (args) => (
    <Grid {...args}>
      {cell}
      {cell}
    </Grid>
  ),
};

export const SeparateAxisGaps: StoryObj<GridProps> = {
  args: { columns: 2, columnGap: 8, rowGap: 1 },
  render: (args) => (
    <Grid {...args}>
      {cell}
      {cell}
      {cell}
      {cell}
    </Grid>
  ),
};
