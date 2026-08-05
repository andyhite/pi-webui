import { Badge } from "./Badge.js";
import { Card, type CardProps } from "./Card.js";
import { Stack } from "./Stack.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<CardProps> = { title: "Toolkit/Card", component: Card };
export default meta;

export const WithTitle: StoryObj<CardProps> = {
  args: { title: "Session summary" },
  render: (args) => (
    <Card {...args}>
      <p style={{ font: "var(--pr-type-body)", color: "var(--pr-text-2)" }}>
        Three workstreams, twelve nodes, last activity 4m ago.
      </p>
    </Card>
  ),
};

export const WithoutTitle: StoryObj<CardProps> = {
  args: {},
  render: (args) => (
    <Card {...args}>
      <p style={{ font: "var(--pr-type-body)", color: "var(--pr-text-2)" }}>
        A plain content inset with no heading — list rows, metric blocks, and
        other summaries that do not need a title line.
      </p>
    </Card>
  ),
};

export const NestedContent: StoryObj<CardProps> = {
  args: { title: "Recent runs", padding: 5 },
  render: (args) => (
    <Card {...args}>
      <Stack gap={3}>
        <Stack direction="row" justify="between" align="center">
          <span
            style={{ font: "var(--pr-type-mono)", color: "var(--pr-text-2)" }}
          >
            plotroom verify
          </span>
          <Badge tone="session">running</Badge>
        </Stack>
        <Stack direction="row" justify="between" align="center">
          <span
            style={{ font: "var(--pr-type-mono)", color: "var(--pr-text-2)" }}
          >
            plotroom build
          </span>
          <Badge tone="neutral">done</Badge>
        </Stack>
        <Stack direction="row" justify="between" align="center">
          <span
            style={{ font: "var(--pr-type-mono)", color: "var(--pr-text-2)" }}
          >
            plotroom test
          </span>
          <Badge tone="alert">failed</Badge>
        </Stack>
      </Stack>
    </Card>
  ),
};
