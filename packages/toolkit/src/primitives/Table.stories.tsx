import { Table, type TableProps } from "./Table.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<TableProps> = { title: "Toolkit/Table", component: Table };
export default meta;

const columns: TableProps["columns"] = [
  { key: "name", label: "NAME" },
  { key: "status", label: "STATUS" },
  { key: "tokens", label: "TOKENS" },
];

const rows: TableProps["rows"] = [
  {
    name: "session-host",
    status: "running",
    tokens: "12,480",
  },
  {
    name: "plotroom-review",
    status: "idle",
    tokens: "3,102",
  },
  {
    name: "scout",
    status: "stopped",
    tokens: "891",
  },
];

export const Basic: StoryObj<TableProps> = {
  args: { columns, rows },
};

export const WithCaption: StoryObj<TableProps> = {
  args: {
    columns,
    rows,
    caption: "Fleet sessions — token use this run",
  },
};
