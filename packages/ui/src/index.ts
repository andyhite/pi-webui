/**
 * @plotroom/ui — canvas and panels (spec §5, §11).
 *
 * React + xyflow. Rigid-body push, collapsing containers, zoom-level
 * semantics, and mid-drag connection refusal are built on top of xyflow;
 * nodes stay DOM-based so plugin cards and keyboard access work.
 */

export * from "./solver/push.js";
export * from "./placement/store.js";
