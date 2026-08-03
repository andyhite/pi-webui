/**
 * A plugin entry point identical to the shipped one **except for its transport**.
 *
 * The host tests load this in a real worker thread, so the manifest, the conformance
 * check, the permission gate, the credential injection and every dispatch are the
 * product's — and the only thing that is not real is Jira. A stub entry rather than an
 * environment switch inside the plugin: a plugin that changed behaviour because of a
 * variable in its environment would be reach nobody granted it.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

import { createJiraPlugin } from "../plugin.js";
import { createRecordedJira } from "./jira-fixture.js";

const manifest: PluginManifest = createJiraPlugin({
  transport: createRecordedJira().transport,
});

export default manifest;
