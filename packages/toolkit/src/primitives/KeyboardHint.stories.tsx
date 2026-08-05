import { KeyboardHint, type KeyboardHintProps } from "./KeyboardHint.js";
import type { Meta, StoryObj } from "./story-kit.js";

const meta: Meta<KeyboardHintProps> = {
  title: "Toolkit/KeyboardHint",
  component: KeyboardHint,
};
export default meta;

export const SingleKey: StoryObj<KeyboardHintProps> = {
  args: { keys: ["Esc"] },
};

export const Chord: StoryObj<KeyboardHintProps> = {
  args: { keys: ["Cmd", "K"] },
};

export const ThreeKeyChord: StoryObj<KeyboardHintProps> = {
  args: { keys: ["Cmd", "Shift", "P"] },
};
