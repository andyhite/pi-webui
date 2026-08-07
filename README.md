# PlotRoom

PlotRoom is a context-authoring canvas for operating a fleet of AI agents: an
operator composes context as a spatial node graph, wires it into commands, and
runs many agent sessions against it at once. Authoring happens at rest, before
anything runs, and steering happens in flight, at the same tempo. It is not a
workflow builder — there are no triggers, schedules, conditional branches, or
loops.

## Start with the spec

[`docs/product-spec.md`](docs/product-spec.md) is the behavioral truth and the
entry point for everything else here — every other document, and the product
itself, is corrected against it.

## Documentation map

| Doc                                                            | Description                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`docs/product-spec.md`](docs/product-spec.md)                 | The definitive statement of what PlotRoom is and how it behaves                |
| [`docs/data-model.md`](docs/data-model.md)                     | The concepts, objects, and relationships that make up the graph                |
| [`docs/enforcement.md`](docs/enforcement.md)                   | How the governing principles are enforced in code, not just documented         |
| [`docs/session-lifecycle.md`](docs/session-lifecycle.md)       | Phases, end states, and delegation for a live or completed session             |
| [`docs/run-lifecycle.md`](docs/run-lifecycle.md)               | How a run is initiated, previewed, executed, and recorded                      |
| [`docs/attention-derivation.md`](docs/attention-derivation.md) | How one derivation of "needs attention" feeds every surface                    |
| [`docs/runtime-boundary.md`](docs/runtime-boundary.md)         | What the product observes from the agent runtime, and where that boundary sits |
| [`docs/plugin-authoring.md`](docs/plugin-authoring.md)         | How to build a plugin against the platform contract                            |
| [`docs/interface-contract.md`](docs/interface-contract.md)     | The shared gesture vocabulary that keeps agents and the UI as peers            |
| [`docs/operations.md`](docs/operations.md)                     | Running, deploying, and maintaining a PlotRoom instance                        |
| [`docs/product-voice.md`](docs/product-voice.md)               | How the product talks to the operator — tone, wording, and copy conventions    |

## Repository layout

- `apps/server` — the HTTP API server; owns runs, budgets, claims, approvals, integrations, and the runtime boundary
- `apps/web` — the React 19 canvas UI operators use to author and steer
- `apps/desktop` — the Tauri v2 desktop shell (a thin Rust main) wrapping the web app: window lifecycle, spawn-or-attach to a local server, and sidecar lifecycle for the compiled server/session-host binaries
- `apps/session-host` — the Bun sidecar embedding the agent runtime, exposing tools and observations to the server
- `packages/core` — the domain model and rule predicates every surface calls, once
- `packages/db` — persistence for the graph, runs, budgets, claims, and credentials
- `packages/ui` — shared UI components: canvas, panels, palette, attention surfaces
- `packages/toolkit` — design tokens and generated theme CSS shared across surfaces
- `packages/plugin-sdk` — the contract, host, and permission model plugins are built against
- `packages/plugins` — the in-box integrations (filesystem, git, GitHub, Jira) built on the plugin SDK

## Development

Development setup and workflow documentation is maintained separately and will be linked here when it lands.
