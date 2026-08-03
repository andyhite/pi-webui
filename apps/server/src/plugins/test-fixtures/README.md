# Server-side plugin fixtures

Real `PluginManifest` modules, loaded by the **real** `worker_threads` host, for the
server's own plugin tests. They are `.ts` and Node runs them by type stripping —
the same thing `packages/plugin-sdk`'s host does when it runs from source — so a
fixture stays readable and typed without a build step of its own.

Nothing here is a stub of the host or of the contract. Each file is a plugin that a
production host would load identically:

- `fake-tickets-plugin.ts` — a healthy plugin with a concept producer and two write
  actions of opposite reversibility. It is the worker-hosted successor to Epic 7.2's
  in-process `integrations/fake-plugin.ts`, which now exists only for
  `IntegrationService`'s unit tests.
- `throws-on-read-plugin.ts` — loads and conforms, then **throws** on a producer
  read. §10.2: a throw is a fault, not a result, so the plugin degrades to
  `unavailable` with the reason.
- `crashes-on-read-plugin.ts` — kills its own worker mid-call, which is the crash
  half of the isolation matrix.
- `not-a-plugin.ts` — loads with no manifest, so it never becomes available at all
  and is **not** retried.
