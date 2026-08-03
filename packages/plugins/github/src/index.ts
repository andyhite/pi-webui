/**
 * `@plotroom/plugin-github` — the GitHub in-box plugin (§9.4).
 *
 * The default export is the manifest the host loads. This module is the only one in
 * the package that touches the network: it supplies a `fetch`-backed transport, so
 * every other module is a description of GitHub that a recorded transport can drive —
 * which is why no test in this repository can reach GitHub.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

import { createGitHubPlugin } from "./plugin.js";
import type { HttpTransport } from "./transport.js";

/**
 * The shipped transport. It carries only what the caller built: no ambient headers,
 * no credential of its own, and no retry that would turn one write into two.
 */
export function fetchTransport(): HttpTransport {
  return async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === null ? {} : { body: request.body }),
    });
    return { status: response.status, body: await response.text() };
  };
}

const manifest: PluginManifest = createGitHubPlugin({
  transport: fetchTransport(),
});

export default manifest;

export { createGitHubPlugin, GITHUB_PLUGIN_ID } from "./plugin.js";
export type { GitHubPluginDeps } from "./plugin.js";
export {
  GITHUB_API_ORIGIN,
  GITHUB_CREDENTIAL_ID,
  GITHUB_CREDENTIAL_SYSTEM,
} from "./transport.js";
export type { HttpRequest, HttpResponse, HttpTransport } from "./transport.js";
