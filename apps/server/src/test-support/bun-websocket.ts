/**
 * #315: the single root TypeScript project now loads the `DOM` lib (for
 * `apps/web`'s renderer) alongside `bun-types`. `bun-types`' global
 * `WebSocket` declaration (`globals.d.ts`) deliberately defers to `lib.dom`'s
 * narrower constructor (`protocols?: string | string[]`, no custom headers)
 * whenever it detects `DOM` is loaded in the program -- correct in a
 * DOM-hosted context, but this file runs under Bun, where the real runtime
 * constructor accepts a `Bun.WebSocketOptions` second argument (custom
 * request headers, used throughout this suite to set `origin`). The
 * ambient type is what changed, not the runtime: this helper reaches past
 * it to the actual accepted shape rather than casting at each call site.
 */
export function openWebSocket(
  url: string,
  options: Bun.WebSocketOptions,
): WebSocket {
  const Ctor = WebSocket as unknown as new (
    url: string,
    options: Bun.WebSocketOptions,
  ) => WebSocket;
  return new Ctor(url, options);
}
