import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

import { resolveDevPorts } from "./src/dev/ports.js";

// Single-origin rule (spec §12): the browser only ever talks to this dev
// server's own port. `/api` and `/ws` are proxied to the backend rather than
// the client ever knowing its address — no hardcoded host or port lives in
// any client code, only here, in the one place a proxy target is allowed.
const ports = resolveDevPorts();
const proxyTarget = `http://127.0.0.1:${ports.proxyTarget}`;

// Dev HMR follows the browser's own port by default (Vite infers it from
// `location`); an asymmetric tunnel (a local port forwarded to a different
// remote one) needs the client to reconnect on the *local* port instead of
// whatever this process thinks it's listening on, hence the override.
const hmrClientPort = process.env.PLOTROOM_HMR_CLIENT_PORT
  ? Number(process.env.PLOTROOM_HMR_CLIENT_PORT)
  : undefined;

// Workspace packages are resolved by their `source` export condition, so the
// dev server, Vitest, and the production bundle all load `@plotroom/*` straight
// from TypeScript source — no `tsc -b --watch` keeping `dist/` fresh, and edits
// anywhere in the renderer chain (ui → core/plugin-sdk/plugins) hot-reload.
// Node never asks for this condition, so the server keeps using `dist/`.
// (Vite 6+ replaces — not extends — the default conditions when this is set,
// hence spreading `defaultClientConditions` back in.)
export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ["source", ...defaultClientConditions],
  },
  server: {
    port: ports.devServer,
    proxy: {
      "/api": { target: proxyTarget, changeOrigin: true },
      "/ws": { target: proxyTarget, ws: true },
    },
    ...(hmrClientPort ? { hmr: { clientPort: hmrClientPort } } : {}),
  },
});
