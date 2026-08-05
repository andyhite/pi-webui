/**
 * `@plotroom/toolkit` — PlotRoom's design system as a package.
 *
 * Track 1 of #86 was the seam: the token layer, the build that emits one
 * stylesheet, and the rule that this package depends on nothing else in the
 * workspace. Track 2 (#102) is the primitive set below; the gallery is #103.
 *
 * The visual source of truth is the Claude Design export in
 * `docs/design/exports/2026-08-04/`, re-implemented here rather than adopted
 * (decision 0002). Its §18 names every value; `tokens.ts` is that table.
 *
 * Consumers import two things: this module for the tokens and primitives, and
 * `@plotroom/toolkit/toolkit.css` — once, at the app entry — for the stylesheet
 * the tokens and Tailwind's utilities live in.
 */

export { DESIGN_TOKENS } from "./tokens.js";
export type { DesignToken, TokenGroup } from "./tokens.js";
export { PLOTROOM_THEME, PLOTROOM_THEME_ID } from "./theme.js";
export type { TokenTheme } from "./theme.js";

export type { Space } from "./primitives/space.js";

export { Box } from "./primitives/Box.js";
export type {
  BoxProps,
  BoxSurface,
  BoxRadius,
  BoxBorder,
} from "./primitives/Box.js";
export { Stack } from "./primitives/Stack.js";
export type {
  StackProps,
  StackDirection,
  StackAlign,
  StackJustify,
} from "./primitives/Stack.js";
export { Grid } from "./primitives/Grid.js";
export type { GridProps } from "./primitives/Grid.js";

export { Button } from "./primitives/Button.js";
export type {
  ButtonProps,
  ButtonTone,
  ButtonSize,
} from "./primitives/Button.js";
export { IconButton } from "./primitives/IconButton.js";
export type { IconButtonProps } from "./primitives/IconButton.js";
export { Badge } from "./primitives/Badge.js";
export type { BadgeProps, BadgeTone } from "./primitives/Badge.js";
export { Spinner } from "./primitives/Spinner.js";
export type { SpinnerProps, SpinnerSize } from "./primitives/Spinner.js";
export { KeyboardHint } from "./primitives/KeyboardHint.js";
export type { KeyboardHintProps } from "./primitives/KeyboardHint.js";

export { Field } from "./primitives/Field.js";
export type { FieldProps } from "./primitives/Field.js";
export { Input } from "./primitives/Input.js";
export type { InputProps, InputSize } from "./primitives/Input.js";
export { Select } from "./primitives/Select.js";
export type {
  SelectProps,
  SelectOption,
  SelectSize,
} from "./primitives/Select.js";

export { Tooltip } from "./primitives/Tooltip.js";
export type { TooltipProps } from "./primitives/Tooltip.js";
export { Dialog } from "./primitives/Dialog.js";
export type { DialogProps } from "./primitives/Dialog.js";

export { Menu } from "./primitives/Menu.js";
export type { MenuProps, MenuItem } from "./primitives/Menu.js";
export { Tabs } from "./primitives/Tabs.js";
export type { TabsProps, TabItem } from "./primitives/Tabs.js";

export { Panel } from "./primitives/Panel.js";
export type { PanelProps } from "./primitives/Panel.js";
export { Card } from "./primitives/Card.js";
export type { CardProps } from "./primitives/Card.js";

export { Banner } from "./primitives/Banner.js";
export type { BannerProps, BannerTone } from "./primitives/Banner.js";
export { Toast } from "./primitives/Toast.js";
export type { ToastProps, ToastTone } from "./primitives/Toast.js";

export { List } from "./primitives/List.js";
export type { ListProps, ListItem } from "./primitives/List.js";
export { Table } from "./primitives/Table.js";
export type { TableProps, TableColumn } from "./primitives/Table.js";
