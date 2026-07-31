/**
 * @plotroom/server — the single owner of all state (spec §12).
 *
 * Hono over HTTP + WebSocket. Both clients — the Electron renderer and a
 * browser pointed at localhost — load the same web app and talk to this
 * server. When the backend is remote, workspaces and diffs refer to this
 * machine, not the operator's.
 */

export const SERVER_NAME = "plotroom-server";
