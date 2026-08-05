# PlotRoom — Interface Contract

**Scope.** How any surface — the web canvas, the desktop shell, an agent session, a hand-written script — talks to the backend, and the one vocabulary that keeps them honest (spec principle 8, §11, §12). Owns the transport: routes, the actor header's mechanics, the refusal shape, the event stream. Who may do what is [enforcement](enforcement.md)'s subject; the runtime sidecar seam is [runtime-boundary](runtime-boundary.md)'s.

---

## 1. Transport

Every surface reaches the backend two ways, both mounted on one `Hono` app by `apps/server/src/app.ts`:

- **HTTP under `/api`.** Each domain area — workstreams, objects, graph, commands, runs, sessions, claims, budgets, approvals, attention, steering, continuation, workspaces, maintenance, search, settings, logs, snapshot, integrations, plugins, standing instructions, and a few more — mounts its own route module under the shared `/api` prefix (`app.route("/api", …)` for each). `configureApp` in `apps/server/src/app.ts` is the one place that shape is assembled; read it for the current grouping rather than trusting a list here, because a route module moves or splits without this document knowing.
- **One `/ws` event stream.** A single WebSocket endpoint, mounted by `mountWsRoute` (`apps/server/src/ws/route.ts`), carries state-change notifications. There is no per-entity socket and no second stream.

Both transports share one origin and one credential gate before either sees a request: `originCheckMiddleware` and `credentialMiddleware` (`apps/server/src/http/middleware.ts`) run ahead of `/api/*` and ahead of `/ws` alike, reading the same `LiveSecurityPolicy` object so a settings change (trusted origins, credential) takes effect on the next request with no restart. `originCheckMiddleware` is the same `checkOrigin` predicate the WS upgrade uses, so the two transports cannot silently diverge on what counts as a trusted caller; `credentialMiddleware` reads `Authorization` or a `credential` query param and answers with the same refusal shape as everything else (§3). Below that sits `actorMiddleware` — see §2 — applied to `/api/*` only, because `/ws` has no actor yet (§4's open gap).

## 2. The actor header

Every `/api` request declares who is making it in `X-PlotRoom-Actor`, parsed by `parseActor` in `apps/server/src/http/actor.ts`:

- Omitted, empty, or the literal string `human` → the operator.
- `session:<sessionId>` → that session, as the acting author.
- Anything else → a 400, because an unattributed or unparseable write has no representation in the schema any more than a body field would.

The header exists because attribution is a property of the _caller_, not of the thing being written — folding it into request bodies would mean every schema restates it and every read-shaped verb has nowhere to put it. Parsing is deliberately pure and separate from policy: `parseActor` only answers "who is this," never "is this actor allowed to do this." What an actor may do — reflexivity, humanOnly gestures, claims, approvals — is decided downstream of the header, and that decision is [enforcement](enforcement.md)'s subject, not this one. The one thing this layer guarantees is that nothing downstream ever sees an unattributed call: the header is set on the request context (`c.set("actor", …)`) before any route runs, human or session, always.

## 3. Refusal shape

A refusal is an answer, not a crash: the request was understood and a rule said no, and every route returns the same shape for that outcome. `apps/server/src/http/errors.ts` defines it once — `ApiError` with a `status`, a machine-readable `code`, a `message`, and optional `details` — and `apps/server/src/http/domain-errors.ts` (`toApiError`) is the single place a domain-level refusal from `@plotroom/core`/`@plotroom/db` becomes that HTTP body:

- An unknown id (`EntityNotFound`) → `404 not_found`.
- A predicate's own refusal (`ConnectionRefused`, `ScopeRefused`, `PlacementRefused`, `LifecycleRefused`, `PublishRefused`, `RunRefused`, `WorkspaceRefused`, and the runtime's own `SessionHostNotReady`/`SessionHostSilent`) → `409 refused`, with `details.reason` carrying the predicate's own machine-readable string verbatim — `would_cycle`, `own_chain`, `runtime_would_not_start`, and so on — so an agent branches on exactly the value the canvas would show mid-drag. Two surfaces reading the same reason string is what keeps them from drifting apart (§5).
- A malformed request (bad actor header, bad body) → `400 bad_request`; a missing/invalid credential → `401 unauthorized`; a blocked origin → `403 forbidden`.
- Anything genuinely unexpected → `500 internal_error`, logged, never carrying a domain reason, because a 500 with a `reason` field would teach a caller to branch on a bug.

The refusal is enforced **upstream of any side effect**. Origin and credential checks, the actor parse, the session-lineage guard (`sessionLineageGuard`), and the destruction guard (`destructionGuard`) all run as middleware ahead of every route handler in `apps/server/src/app.ts`, and a route's own predicate check (e.g. `checkConnection`, `wouldCycle` in `packages/core`) runs before the store mutates anything. A refused call — from the canvas, from a script, from an agent tool — never partially applies.

## 4. The event stream protocol

`/ws` (`apps/server/src/ws/route.ts`) speaks two message shapes, both JSON:

```ts
type WsServerMessage =
  | { type: "hello"; nextSeq: number; serverTime: number }
  | { type: "event"; event: DomainEvent };
```

On open, the server sends exactly one `hello` carrying the event bus's current sequence number and its own clock — not a snapshot, just where the stream is right now. From then on, every `DomainEvent` published to the bus is forwarded, in sequence, to the socket. There is no server-side filtering and no catch-up buffer: a client that was offline does not receive what it missed over the wire. **Resync is two steps a client owns**: pull a fresh REST snapshot (whatever `GET` the panel needs — e.g. `snapshotRoutes`), then reconnect and resume applying events from the `hello` it receives, using `nextSeq` to detect a gap rather than trusting that none occurred.

**Open gap (issue [#207](https://github.com/andyhite/plotroom/issues/207)):** every socket receives every event on the bus, unfiltered by actor or entity. There is no actor resolved at the WS handshake — `parseActor` is never called on this path — so a connection that passes the shared origin/credential gate sees everything published, including approval asks with their full ask sentence. This is a recorded decision still open, not an oversight this document is pretending is fine: either an actor gets resolved at handshake and the bus gets filtered per subscriber, or the stream is decided to be the operator's alone and a session-attributed handshake is refused outright. Until one of those lands, treat `/ws` as operator-scoped in practice even though nothing enforces it.

## 5. The one-vocabulary rule

Every gesture — human or agent — is declared exactly once, in `packages/core/src/sessions/tools/catalog.ts`. `AGENT_TOOL_CATALOG` is the full declaration: each `AgentTool` names its HTTP method and endpoint (exactly as the server mounts it), its input shape, and what it requires — a claim, an approval, a lineage check, or the operator (`requires.humanOnly`). `sessionCallableTools()` filters that catalog down to what a session may call at all, by excluding every `humanOnly` tool; `liveTools()` filters to what is actually mounted today versus `availability: "pending"`.

Two things keep this from rotting into aspiration:

- **`catalog.test.ts` pins the catalog against the server's mounted routes, in both directions.** It scans `apps/server/src/routes/*.ts` for every `app.get/post/put/patch/delete` call and checks: every mounted mutating route has a matching catalog tool (or is on the explicit `OPERATOR_ONLY_ROUTES` list), and every `live` catalog tool names an endpoint that route scan actually found. A gesture cannot land for one surface only.
- **`createSessionToolBridge` (`packages/core/src/sessions/tools/bridge.ts`) turns a call into the same HTTP request the canvas makes.** Given a tool name and arguments, `buildToolRequest` resolves the catalog entry, substitutes path parameters, sets `X-PlotRoom-Actor` from the session binding the bridge holds (never from anything the agent supplies), and runs the reflexivity check (`checkToolCall`, principle 1) before anything is sent. A refused call never reaches the transport, so a refused call has no chance of a side effect — the same guarantee §3 states for HTTP refusals generally, enforced a second time at this seam.

**Open gap (issue [#160](https://github.com/andyhite/plotroom/issues/160)):** the catalog and the bridge are both real, and neither has a non-test consumer today. No runtime adapter registers the catalog's tools into a live session — grepping `createSessionToolBridge`/`AGENT_TOOL_CATALOG` across `apps/**` turns up only the two source files and their tests. A PlotRoom session today can call zero PlotRoom gestures through this path; the vocabulary is declared and pinned, but not yet wired into the runtime that would call it. In-session tool registration is the recorded direction, not yet the recorded fact.

## 6. Worked recipe: adding one gesture end to end

Say the gesture is "rename a workstream." The steps, in the order a missing one gets caught:

1. **Predicate in `packages/core`.** Add the rule — e.g. a `checkRename` function beside `checkConnection` in a core module (the pattern `edges.ts` / `edges.test.ts` follows for connection legality) — with its own unit test asserting the refusal shape (`{ legal: false, refusal: { reason, message } }` or the store throwing a typed `*Refused` error). Skip this and there is no rule to call; the next step has nothing to import.
2. **Route in `apps/server`.** Add `app.patch("/api/workstreams/:id/rename", …)` to `apps/server/src/routes/workstreams.ts` (or wherever the domain module lives), calling the store method that invokes the new predicate and letting `toApiError` (§3) turn a refusal into the standard body. Skip the catalog entry after this and `catalog.test.ts`'s **"each [mounted route] have a tool over the same endpoint"** assertion fails — the scanner finds the new `PATCH` route and no tool matches it, unless it is deliberately added to `OPERATOR_ONLY_ROUTES`.
3. **Catalog entry in `packages/core/src/sessions/tools/catalog.ts`.** Add an `AgentTool` (via the `mutate()` helper) naming `PATCH /api/workstreams/:id/rename`, its input (the new name, the path `id`), and its `requires` (reflexivity class, `humanOnly: false`, approval tier). Get the endpoint wrong, or add the tool before the route exists, and `catalog.test.ts`'s **"names an endpoint the server actually mounts, for every live tool"** assertion fails — a dangling tool with nowhere to land.
4. **Surfaces pick it up.** For the agent surface, nothing else is needed once (2) and (3) exist and issue [#160](https://github.com/andyhite/plotroom/issues/160) is closed: `createSessionToolBridge` resolves any call named `workstream_rename` generically, against the catalog entry, into the same request the canvas would send. For the web canvas, the catalog does not generate UI — `apps/web` still needs its own call site (an action wired through `createApiActions`/`httpClient`) hitting the identical endpoint, so the two surfaces read the same refusal (§3) even though each wires its own trigger.

Miss any of steps 1–3 and a test fails before anything ships silently broken; miss step 4's web half and nothing fails — a human notices there is no button, which is the one part of this recipe not yet enforced by a test.

## 7. How the web surface consumes this

`apps/web/src/App.tsx` wires every panel's data through a `LIVE` flag (`VITE_USE_FIXTURES !== "1"`): live, each data source is built over the same `httpClient`/`createSocket` pair — `createApiGraphDataSource`, `createApiSessionDataSource`, `createApiAttentionDataSource`, and so on — that call `/api` for state and open `/ws` for the change feed described in §4. Fixture-fed, the identical data-source interface is satisfied from static fixtures (`FIXTURE_SNAPSHOT`, `FIXTURE_SESSIONS`, `FIXTURE_ATTENTION_ITEMS`, …) with no network calls at all, which is what lets the canvas render and be tested without a server running.

The two modes are not a fork of behavior, only of source: every panel consumes the same shape whether it came from a live snapshot-plus-events pair or a fixture constant, because the data-source interfaces are defined once and implemented twice. This is the same discipline §5 states for gestures — one vocabulary, multiple backings — applied to reads instead of writes: the canvas cannot drift between what it renders live and what it renders offline, because both paths satisfy the same contract.
