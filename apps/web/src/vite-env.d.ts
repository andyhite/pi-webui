/// <reference types="vite/client" />

/**
 * The one bridge Electron's preload exposes (`apps/desktop/src/preload.ts`):
 * present only when this renderer is loaded inside the desktop shell,
 * `undefined` in a plain browser tab (§12 — one renderer, two hosts). Every
 * caller feature-detects it with `?.` rather than assuming Electron.
 */
interface Window {
  readonly plotroom?: {
    readonly setBadgeCount: (count: number) => void;
  };
}
