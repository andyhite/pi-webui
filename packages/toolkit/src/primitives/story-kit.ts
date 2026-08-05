import type { ReactElement } from "react";

/**
 * A placeholder for Storybook's own CSF3 types, shaped to match them exactly.
 *
 * #102 lands every primitive with its stories, but the runner is #103's — "if
 * this ticket lands before #103 wires the runner, it still carries the
 * stories" (issue #102). Depending on `@storybook/react` here would add a
 * devDependency #103 owns before the package it configures exists, so this
 * module is the minimal structural stand-in: a `.stories.tsx` file written
 * against it reads exactly like CSF3 (`export default meta`, one named export
 * per story with an `args` object) and needs no change when #103 installs the
 * real types — `Meta<P>`/`StoryObj<P>` there are structurally the same shape.
 */
export interface Meta<Props> {
  readonly title: `Toolkit/${string}`;
  readonly component: (props: Props) => ReactElement | null;
}

export interface StoryObj<Props> {
  readonly args: Props;
  /** Only for a story a plain `args` render cannot express (e.g. children). */
  readonly render?: (args: Props) => ReactElement | null;
}
