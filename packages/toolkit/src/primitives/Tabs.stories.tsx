import { Tabs, type TabItem, type TabsProps } from "./Tabs.js";
import type { Meta, StoryObj } from "./story-kit.js";

const tabs: TabItem[] = [
  {
    id: "overview",
    label: "Overview",
    panel: "Session summary and status.",
  },
  {
    id: "transcript",
    label: "Transcript",
    panel: "Full message history for this session.",
  },
  {
    id: "artifacts",
    label: "Artifacts",
    panel: "Files produced during the run.",
  },
];

const meta: Meta<TabsProps> = { title: "Toolkit/Tabs", component: Tabs };
export default meta;

export const Default: StoryObj<TabsProps> = {
  args: { tabs },
};

export const DefaultSelectedId: StoryObj<TabsProps> = {
  args: { tabs, defaultSelectedId: "transcript" },
};

export const DisabledTab: StoryObj<TabsProps> = {
  args: {
    tabs: [tabs[0]!, { ...tabs[1]!, disabled: true }, tabs[2]!],
  },
};
