# Commands, runs, previews, and the queue

How a command becomes a run, how a run's output is addressed, and how a scoped batch is admitted rather than scheduled. The preview is the contract; several rules below are CHECK constraints rather than conventions, so no call site can get them wrong — keep them that way.

**Scoped runs and the queue** live in `run_batches` / `run_queue` (migrations 13, 14
and 15). One batch is one gesture over a scope; one entry is one command, admitted
rather than scheduled. Every entry carries `contract_hash` — the configuration plus
every input's version and content, in assembly order — because **the preview is the
contract**: at admission the preview is taken again, and a mismatch re-asks instead
of running something else.

Two rules qualify that, and both are decisions rather than implementation details.
**The in-batch rule:** a subgraph was previewed as a chain, so an input produced by
another command in the same batch is the contract _executing_, not drifting — those
inputs and the `runnable` flip they cause are excluded from that entry's hash, and
the entry waits rather than being admitted while its in-batch producer is still to
run. A producer that _settled_ without producing is not a producer to wait for
("not done" and "not finished yet" are different facts): the entry is settled with a
reason naming it, unless the output arrived anyway, in which case the ordinary
contract check re-asks. Drift from outside the batch re-asks exactly as before. **Confirming answers to the batch:** into a
paused batch a confirmation is kept and the entry parked (resuming is still the
operator's separate gesture); into an aborted or completed one it is refused.

There is no timer anywhere in it: the queue drains from the session event stream,
including for a session that never went through it, and once at boot after
reconciling entries the last process left in flight — a boot-time drain admits work
already initiated by a gesture, which is §4.1's "deciding _when_, never _whether_".
A queue entry's state carries `interrupted` for the same reason the session and the
run do (principle 11): a restart that reported those as `done` was reporting success
for work that never happened.

An **initiation does not always produce a run** (migration 17): a fork, a handoff, and
a resume each spend a key and produce a session, so `run_initiations.command_id` is
nullable. And a settled key names its **whole gesture** — its kind
(migration 18) and its subject (migration 19): a run of command X and a fork of one of
that command's sessions both name X, and a handoff named no brief at all, so a reused
key wired one brief's content into another's session and marked it sent for ever. Every steering gesture **replays** a repeated key with what the first attempt
produced — none of them refuse one — which is what makes the id-stable writes behind
them load-bearing: `addContextEdge` returns an existing edge for a supplied id before
any legality check, and `recordProvenance` is idempotent in the fact it states. And `sessions.runtime_mode` records **which fork branch ran** — native or
seeded — because the pi adapter refuses to substitute one for the other, which is what
makes the column trustworthy.

**Commands and runs** live in `command_definitions` / `commands` /
`command_parameter_bindings` / `command_outputs` and `runs` / `run_inputs` /
`run_outputs` (migration 5). Four §3.5 rules are schema constraints rather
than conventions, so no call site can get them wrong:

- a `producing` definition cannot exist without an expected outcome, and an
  `open` one cannot carry one;
- a `proposed` parameter binding cannot carry a `confirmed_at`, so a derived
  default is never readable as a confirmed value (`resolveParameters` refuses
  to produce run configuration while one is outstanding);
- a bound `command_outputs` row cannot be marked `broken_at` — post-bind the
  command dependency has evaporated, so only a pre-bind placeholder breaks;
- `runs.assembled_blob_id` and `runs.config_json` are `NOT NULL` (§15-1), and
  `run_inputs.version_id` is a real foreign key, so a version a run consumed
  cannot be deleted while the run exists (§15-3's interplay).

**The run preview** (§4.1) is `RunStore.plan`, and `start()` reads the same plan
rather than a second description of it — a preview that could disagree with the
run it previews is worse than no preview. Refusals are _collected_ there and
thrown only by the run path, because the preview's job is to say what is
missing. Cost estimates go through `estimateRunCost`, whose type cannot express
a bare number: a basis, a range that is `null` when nothing has ever been
priced, and a sentence. Estimates are priced per **definition**, matching
retention's grain, and a run whose runtime reported no cost is no evidence about
money. `runs.spend_cap_micros` records what the operator accepted; Phase 6
enforces it.

There is deliberately **no `latest` column anywhere**: `RunStore.resolve`
orders by `runs.ordinal`, so `output@n` is the general address and `latest` is
one query over it (§15-4). Publish (`command_outputs.published_at`, pre-run,
on a placeholder) and promote (`ObjectStore.promote`, after the fact, on an
object) stay two verbs; publishing a bound output is refused.
