import { useState } from "react";

import { Button } from "./Button.js";
import { Dialog, type DialogProps } from "./Dialog.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<DialogProps> = { title: "Toolkit/Dialog", component: Dialog };
export default meta;

export const Closed: StoryObj<DialogProps> = {
  args: {
    open: false,
    title: "Confirm action",
    onClose: () => undefined,
    children: "Dialog body is not rendered while closed.",
  },
  render: (args) => (
    <>
      <p
        style={{
          font: "var(--pr-type-body)",
          marginBottom: "var(--pr-space-4)",
        }}
      >
        Nothing below — the dialog returns null when closed.
      </p>
      <Dialog {...args} />
    </>
  ),
};

export const Open: StoryObj<DialogProps> = {
  args: {
    open: true,
    title: "Confirm action",
    onClose: () => undefined,
    children: "Focus is trapped inside while open. Press Escape to close.",
  },
};

export const TitleAndContent: StoryObj<DialogProps> = {
  args: {
    open: true,
    title: "Delete session",
    onClose: () => undefined,
  },
  render: (args) => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Reopen dialog</Button>
        <div style={{ marginTop: "var(--pr-space-6)" }}>
          <Dialog {...args} open={open} onClose={() => setOpen(false)}>
            <p style={{ marginBottom: "var(--pr-space-6)" }}>
              This removes the session and its fork history from the graph.
            </p>
            <div style={{ display: "flex", gap: "var(--pr-space-3)" }}>
              <Button tone="alert" onClick={() => setOpen(false)}>
                Delete
              </Button>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </Dialog>
        </div>
      </>
    );
  },
};
