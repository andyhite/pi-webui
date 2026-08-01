/**
 * @plotroom/ui — canvas and panels (spec §5, §11).
 *
 * React + xyflow. Rigid-body push, collapsing containers, zoom-level
 * semantics, and mid-drag connection refusal are built on top of xyflow;
 * nodes stay DOM-based so plugin cards and keyboard access work.
 */

export * from "./solver/push.js";
export * from "./placement/store.js";
export * from "./routing/selection.js";
export * from "./routing/use-selection-route.js";
export * from "./zoom/level.js";
export * from "./containers/collapse.js";
export * from "./selection/multi-select.js";
export * from "./attention/off-screen.js";
export * from "./legality/create-menu.js";
export * from "./undo/stack.js";
export * from "./context-order/reorder.js";
export * from "./context-order/ContextInputList.js";
export * from "./notes/model.js";
export * from "./notes/NotePanel.js";
export * from "./gestures/one-gesture.js";
export * from "./canvas/PlotCanvas.js";
