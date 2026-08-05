import { useEffect, useRef } from "react";

import { Menu, type MenuItem, type MenuProps } from "./Menu.js";
import type { Meta, StoryObj } from "./story-kit.js";

const items: MenuItem[] = [
  { id: "run", label: "Run", onSelect: () => undefined },
  { id: "diff", label: "Show diff", onSelect: () => undefined },
  { id: "delete", label: "Delete", onSelect: () => undefined },
];

const meta: Meta<MenuProps> = { title: "Toolkit/Menu", component: Menu };
export default meta;

export const Default: StoryObj<MenuProps> = {
  args: { trigger: "Actions", items },
};

export const WithDisabledItem: StoryObj<MenuProps> = {
  args: {
    trigger: "Actions",
    items: [
      { id: "run", label: "Run", onSelect: () => undefined },
      {
        id: "pause",
        label: "Pause",
        onSelect: () => undefined,
        disabled: true,
      },
      { id: "stop", label: "Stop", onSelect: () => undefined },
    ],
  },
};

function OpenMenuDemo(props: MenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.querySelector("button")?.click();
  }, []);
  return (
    <div ref={rootRef}>
      <Menu {...props} />
    </div>
  );
}

export const Open: StoryObj<MenuProps> = {
  args: { trigger: "Actions", items },
  render: (args) => <OpenMenuDemo {...args} />,
};
