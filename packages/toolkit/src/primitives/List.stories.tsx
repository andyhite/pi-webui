import { List, type ListProps } from "./List.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<ListProps> = { title: "Toolkit/List", component: List };
export default meta;

export const Plain: StoryObj<ListProps> = {
  args: {
    items: [
      { id: "a", content: "First row — static prose" },
      { id: "b", content: "Second row — no handler" },
      { id: "c", content: "Third row — still static" },
    ],
  },
};

export const InteractiveRows: StoryObj<ListProps> = {
  args: {
    items: [
      {
        id: "open",
        content: "Open session transcript",
        onSelect: () => undefined,
      },
      {
        id: "copy",
        content: "Copy run id",
        onSelect: () => undefined,
      },
      {
        id: "static",
        content: "Pinned — not activatable",
      },
      {
        id: "archive",
        content: "Archive workstream",
        onSelect: () => undefined,
      },
    ],
  },
};
