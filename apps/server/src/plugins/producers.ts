import type {
  ContributionDescriptor,
  PluginActor,
  PluginCallContext,
  PluginDescriptor,
  ReadRequest,
  ReadResult,
  RefreshMode,
  ScopingDeclaration,
  ToolInputSchema,
  WriteAction,
  WriteResult,
} from "@plotroom/plugin-sdk";
import type { IntegrationProducer } from "../integrations/registry.js";
import type { PluginInvoker } from "./invoker.js";

/**
 * A plugin's concept producers and write actions, as the integration substrate
 * sees them — **over the worker boundary** (§10.2, Epics 7.2/7.3).
 *
 * This is what replaced the direct-invocation seam. `IntegrationRegistry` used to
 * hold same-process objects whose `read`/`perform` were plain function calls; it
 * now holds these, whose `read`/`perform` are `host.invoke` — one worker per
 * plugin, permissions gated at the boundary, credentials injected per call and
 * redacted out of the answer. **Nothing above the registry changed**, which was the
 * whole point of that seam: `IntegrationService` still calls `producer.read(...)`
 * and `action.perform(...)`, and still reconciles what comes back through
 * `ObjectStore`.
 *
 * Three properties of the mapping are decisions rather than mechanics:
 *
 * - **The `scoping` declaration travels verbatim.** §9.1 makes the scope the
 *   source's own query language, and the settings surface shows the plugin's own
 *   `language`/`example` rather than a paraphrase (Epic 7.3's ask of this track).
 * - **A write action belongs to its plugin, not to one producer.** The frozen
 *   contract names no producer on a `WriteAction`, so every producer of a plugin
 *   offers that plugin's actions: an integration connected to
 *   `github-pull-requests` can perform `github-merge-pull-request` because both are
 *   GitHub's. Inventing a producer↔action mapping the contract does not express
 *   would be a call site's guess, which is what principle 8 rules out.
 * - **The caller's `PluginCallContext` is read for one field and otherwise
 *   ignored.** The host builds the real context — invocation id, actor, granted
 *   credentials, grants, log — and a caller-supplied credential set is exactly what
 *   §9.3 forbids. What the caller's context legitimately carries is `actor`: who
 *   the call acts as, which is what a §6.6 raise needs in order to be asked
 *   against a session at all.
 *
 * A contribution whose declaration cannot be read is **reported, not defaulted**:
 * inventing an empty scoping declaration or an `on-demand` refresh mode for it
 * would put a producer on the settings surface describing itself with facts nobody
 * declared (principle 12).
 */
export interface HostedContributions {
  readonly producers: readonly IntegrationProducer[];
  /** Contributions whose declaration could not be read, named rather than dropped. */
  readonly unreadable: readonly string[];
}

export function hostedContributions(input: {
  readonly descriptor: PluginDescriptor;
  readonly invoker: PluginInvoker;
  /** Which workstream a session belongs to, for the ask's scope. */
  readonly workstreamOf?: (sessionId: string) => string | null;
}): HostedContributions {
  const unreadable: string[] = [];
  const declaredActions = readWriteActions(input.descriptor, unreadable);
  const producers: IntegrationProducer[] = [];
  const pluginId = input.descriptor.id;

  const options = (
    context: PluginCallContext | undefined,
  ): {
    readonly actor?: PluginActor | null;
    readonly sessionId?: string | null;
    readonly workstreamId?: string | null;
  } => {
    const actor = context?.actor ?? null;
    if (actor === null) return {};
    const sessionId = String(actor.sessionId);
    return {
      actor,
      sessionId,
      workstreamId:
        input.workstreamOf?.(sessionId) ?? String(actor.workstreamId),
    };
  };

  for (const contribution of input.descriptor.contributions) {
    if (contribution.point !== "concept-producer") continue;
    const declaration = readProducerDeclaration(contribution);
    if (declaration === null) {
      unreadable.push(`${contribution.point} ${contribution.id}`);
      continue;
    }

    const writeActions: WriteAction[] = declaredActions.map((action) => ({
      id: action.id,
      action: action.action,
      system: action.system,
      reversibility: action.reversibility,
      input: action.input,
      permissions: action.permissions,
      perform: (
        actionInput: unknown,
        context: PluginCallContext,
      ): Promise<WriteResult> =>
        input.invoker.invoke(
          pluginId,
          {
            kind: "write.perform",
            contributionId: action.id,
            input: actionInput,
          },
          options(context),
        ),
    }));

    producers.push({
      pluginId,
      id: contribution.id,
      kinds: declaration.kinds,
      refresh: declaration.refresh,
      scoping: declaration.scoping,
      permissions: contribution.permissions,
      read: (
        request: ReadRequest,
        context: PluginCallContext,
      ): Promise<ReadResult> =>
        input.invoker.invoke(
          pluginId,
          {
            kind: "concept.read",
            contributionId: contribution.id,
            request,
          },
          options(context),
        ),
      writeActions,
    });
  }

  return { producers, unreadable };
}

interface ProducerDeclaration {
  readonly kinds: IntegrationProducer["kinds"];
  readonly refresh: RefreshMode;
  readonly scoping: ScopingDeclaration;
}

function readProducerDeclaration(
  contribution: ContributionDescriptor,
): ProducerDeclaration | null {
  const declaration = contribution.declaration;
  const kinds = declaration["kinds"];
  const refresh = declaration["refresh"];
  const scoping = declaration["scoping"];
  if (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== "string")) {
    return null;
  }
  if (!isRecord(refresh) || typeof refresh["kind"] !== "string") return null;
  if (
    !isRecord(scoping) ||
    typeof scoping["language"] !== "string" ||
    typeof scoping["example"] !== "string"
  ) {
    return null;
  }
  return {
    kinds: kinds as IntegrationProducer["kinds"],
    refresh: refresh as unknown as RefreshMode,
    scoping: { language: scoping["language"], example: scoping["example"] },
  };
}

interface WriteActionDeclaration {
  readonly id: string;
  readonly action: string;
  readonly system: string;
  readonly reversibility: "reversible" | "irreversible" | "unknown";
  readonly input: ToolInputSchema;
  readonly permissions: readonly string[];
}

function readWriteActions(
  descriptor: PluginDescriptor,
  unreadable: string[],
): readonly WriteActionDeclaration[] {
  const actions: WriteActionDeclaration[] = [];
  for (const contribution of descriptor.contributions) {
    if (contribution.point !== "write-action") continue;
    const declaration = contribution.declaration;
    const action = declaration["action"];
    const system = declaration["system"];
    const reversibility = declaration["reversibility"];
    if (
      typeof action !== "string" ||
      typeof system !== "string" ||
      (reversibility !== "reversible" &&
        reversibility !== "irreversible" &&
        reversibility !== "unknown")
    ) {
      // Conformance already refuses a write action with no reversibility at load
      // (§9.2); this is the belt-and-braces read, and it names what it skipped.
      unreadable.push(`${contribution.point} ${contribution.id}`);
      continue;
    }
    actions.push({
      id: contribution.id,
      action,
      system,
      reversibility,
      input: (isRecord(declaration["input"])
        ? declaration["input"]
        : {}) as ToolInputSchema,
      permissions: contribution.permissions,
    });
  }
  return actions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
