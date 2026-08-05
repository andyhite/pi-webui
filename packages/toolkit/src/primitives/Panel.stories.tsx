import type { ReactElement } from "react";

import { Panel, type PanelProps } from "./Panel.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<PanelProps> = { title: "Toolkit/Panel", component: Panel };
export default meta;

const canvas = (panel: ReactElement) => (
  <div
    style={{
      padding: "var(--pr-space-11)",
      background: "var(--pr-canvas)",
      minHeight: 320,
    }}
  >
    <div style={{ width: "var(--pr-panel-conversation-w)" }}>{panel}</div>
  </div>
);

export const WithTitle: StoryObj<PanelProps> = {
  args: { title: "Conversation" },
  render: (args) =>
    canvas(
      <Panel {...args}>
        <p style={{ font: "var(--pr-type-body)", color: "var(--pr-text-2)" }}>
          Panel body beside the graph — floating chrome, not part of it.
        </p>
      </Panel>,
    ),
};

export const WithoutTitle: StoryObj<PanelProps> = {
  args: {},
  render: (args) =>
    canvas(
      <Panel {...args}>
        <p style={{ font: "var(--pr-type-body)", color: "var(--pr-text-2)" }}>
          A titleless panel for chrome-adjacent tools that name themselves
          inside the body.
        </p>
      </Panel>,
    ),
};
