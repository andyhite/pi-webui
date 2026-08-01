import {
  decideApproval,
  integrationToolName,
  integrationWriteAsk,
  isIntervalRefreshDue,
  type Approval,
  type Author,
  type Integration,
  type PiercedPreGrant,
  type PreGrant,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { draft } from "@plotroom/plugin-sdk";
import { forbidden, notFound, refused } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import type { ApiStores } from "../routes/api.js";
import {
  type IntegrationProducer,
  type IntegrationRegistry,
  toCoreObjectKind,
  toCoreRenderings,
} from "./registry.js";

/**
 * What the write-action approval path needs from `ApprovalService`, mirroring
 * `sessions/gate.ts`'s `GateApprovals` — the same seam, because a write action
 * raises exactly the approval class the write gate does (§6.6, §9.2).
 */
export interface IntegrationApprovals {
  preGrantsFor(
    sessionId: string,
    workstreamId: string | null,
  ): readonly PreGrant[];
  forCall(sessionId: string, callId: string): Approval | undefined;
  raise(input: {
    readonly sessionId: string;
    readonly workstreamId?: string;
    readonly ask: ReturnType<typeof integrationWriteAsk>;
    readonly callId?: string | null;
    readonly pierced?: PiercedPreGrant | null;
  }): Approval;
}

export interface IntegrationServiceDeps {
  readonly stores: ApiStores;
  readonly registry: IntegrationRegistry;
  readonly logger: Logger;
  readonly approvals?: IntegrationApprovals;
}

export interface ConnectIntegrationInput {
  readonly pluginId: string;
  readonly producerId: string;
  readonly name: string;
  readonly scope?: string | null;
  readonly credentialName?: string;
  readonly credentialValue?: string;
}

export type RefreshOutcome =
  | {
      readonly ok: true;
      readonly integration: Integration;
      readonly objectsWritten: number;
      readonly unavailable: readonly { externalId: string; why: string }[];
    }
  | {
      readonly ok: false;
      readonly integration: Integration;
      readonly reason: string;
    };

/**
 * `"denied"` is not a variant here on purpose: a denial is thrown as a
 * `refused` `ApiError` (§6.6's "deny is feedback", carried the same way every
 * other refusal in this API is), rather than a third shape every caller would
 * have to branch on. `"must-ask"` is a variant because it is not a failure —
 * §4.1's "deciding when, never whether" reads the same way here: the gesture
 * was accepted and is waiting on a person.
 */
export type PerformWriteOutcome =
  | {
      readonly kind: "executed";
      readonly ok: boolean;
      readonly message: string;
      readonly readBack: draft.DraftProducedObject | null;
    }
  | { readonly kind: "must-ask"; readonly approval: Approval };

/**
 * The integration substrate's own service (Epic 7.2).
 *
 * Three responsibilities, each traced to a spec section in its method:
 *
 * - **connect/disconnect/updateScoping** (§9.1, §9.3): the connect-flow state
 *   machine, over `IntegrationStore` and `CredentialStore`.
 * - **refresh** (§9.1, §3.2): a read, reconciled through `ObjectStore` —
 *   external identity reconciles, identical content writes nothing, changed
 *   content bumps a version and therefore drifts. A failed read marks the
 *   connection broken; it never touches an object already on the board (§3.1).
 * - **performWrite** (§9.2, §6.6): the UI-action-and-agent-tool execution path,
 *   with the approval decision inline (a session's call), and a read-back that
 *   is never assumed — the same `read()` refresh runs again afterward and its
 *   answer, not the request, is what the caller is told.
 */
export class IntegrationService {
  constructor(private readonly deps: IntegrationServiceDeps) {}

  producers(): readonly IntegrationProducer[] {
    return this.deps.registry.list();
  }

  connect(input: ConnectIntegrationInput): Integration {
    const producer = this.requireProducer(input.producerId);
    const integration = this.deps.stores.integrations.connect({
      pluginId: input.pluginId,
      producerId: input.producerId,
      name: input.name,
      system: producer.id,
      scope: input.scope ?? null,
    });

    if (
      input.credentialName !== undefined &&
      input.credentialValue !== undefined
    ) {
      this.deps.stores.credentials.put(
        integration.id,
        input.credentialName,
        input.credentialValue,
      );
    }

    this.deps.logger.info("integration connected", {
      integrationId: integration.id,
      producerId: integration.producerId,
    });
    return integration;
  }

  disconnect(id: string): Integration {
    const integration = this.deps.stores.integrations.disconnect(id);
    this.deps.stores.credentials.clear(id);
    return integration;
  }

  updateScoping(id: string, scope: string | null): Integration {
    return this.deps.stores.integrations.updateScoping(id, scope);
  }

  list(): readonly Integration[] {
    return this.deps.stores.integrations.list();
  }

  get(id: string): Integration {
    const integration = this.deps.stores.integrations.get(id);
    if (integration === null) throw notFound(`unknown integration ${id}`);
    return integration;
  }

  /**
   * One read, reconciled (§9.1, §3.2). `externalId` narrows to a per-object
   * refresh — "manual refresh always available per integration and per
   * object" — omitted for the whole-integration read a schedule or a manual
   * gesture asks for.
   */
  async refresh(
    id: string,
    options: { readonly externalId?: string } = {},
  ): Promise<RefreshOutcome> {
    const integration = this.get(id);
    const producer = this.requireProducer(integration.producerId);

    let result: draft.DraftReadResult;
    try {
      result = await producer.read({
        scope: integration.scope,
        externalId: options.externalId ?? null,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const broken = this.deps.stores.integrations.markBroken(id, reason);
      this.deps.logger.warn("integration refresh failed", {
        integrationId: id,
        reason,
      });
      return { ok: false, integration: broken, reason };
    }

    let written = 0;
    for (const object of result.objects) {
      this.deps.stores.objects.write({
        kind: toCoreObjectKind(object.kind),
        title: object.title,
        renderings: toCoreRenderings(object.renderings),
        external: { system: integration.system, id: object.externalId },
      });
      written += 1;
    }

    const refreshed = this.deps.stores.integrations.markRefreshed(id);
    return {
      ok: true,
      integration: refreshed,
      objectsWritten: written,
      unavailable: result.unavailable,
    };
  }

  /**
   * Every connected integration whose declared mode is `interval` and whose
   * schedule is due right now — the refresh job's own read
   * (`refresh-job.ts`), kept here so the predicate and the store query travel
   * together.
   */
  dueForScheduledRefresh(now: number): readonly Integration[] {
    return this.deps.stores.integrations.connected().filter((integration) => {
      const producer = this.deps.registry.get(integration.producerId);
      if (producer === undefined) return false;
      return isIntervalRefreshDue(
        producer.refresh,
        integration.lastRefreshAt,
        now,
      );
    });
  }

  /**
   * Perform a declared write action (§9.2, §6.6): the execution path shared by
   * the UI action endpoint and the agent tool.
   *
   * A human actor is never gated (`decideApproval`'s own first rule) and
   * executes directly. A session actor's call goes through the same
   * `toolCallAsk`/`decideApproval` machinery `decideToolPermission` uses,
   * matched on `callId` for idempotent retries (principle 9) exactly like
   * `sessions/gate.ts` matches on the runtime's own call id.
   *
   * **The result is read back, never assumed** (§9.2): whether or not the
   * action's own `readBack` came back populated, this re-reads the object by
   * its external id, reconciles it through `ObjectStore` like any other
   * refresh, and returns what that reconciliation actually found —
   * `perform`'s own `message` travels verbatim, rejection text included.
   */
  async performWrite(input: {
    readonly integrationId: string;
    readonly actionId: string;
    readonly actionInput: unknown;
    readonly actor: Author;
    readonly callId: string;
  }): Promise<PerformWriteOutcome> {
    const integration = this.get(input.integrationId);
    const action = this.deps.registry.writeAction(
      integration.producerId,
      input.actionId,
    );
    if (action === undefined) {
      throw notFound(
        `${integration.producerId} declares no write action ${input.actionId}`,
      );
    }

    if (input.actor.kind === "session") {
      const routing = this.decideWrite(integration, action, input);
      if (routing.kind !== "allowed") return routing;
    }

    const result = await action.perform(input.actionInput);

    // Read-back, never assumed: re-derive what is true now, whatever `perform`
    // claimed, and reconcile it like any other refresh (§9.1, §3.2).
    const externalId = readBackExternalId(result, input.actionInput);
    if (externalId !== null) {
      await this.refresh(integration.id, { externalId });
    }

    return {
      kind: "executed",
      ok: result.ok,
      message: result.message,
      readBack: result.readBack,
    };
  }

  private decideWrite(
    integration: Integration,
    action: draft.DraftWriteAction,
    input: {
      readonly actionId: string;
      readonly actor: Author;
      readonly callId: string;
    },
  ): { readonly kind: "allowed" } | PerformWriteOutcome {
    if (input.actor.kind !== "session") return { kind: "allowed" };
    const sessionId = input.actor.sessionId;
    const ask = integrationWriteAsk({
      producerId: integration.producerId,
      action: {
        id: action.id,
        action: action.action,
        system: action.system,
        reversibility: action.reversibility,
      },
      summary: `${integrationToolName(integration.producerId, action.id)} on ${integration.name}`,
    });

    const approvals = this.deps.approvals;
    const existing = approvals?.forCall(sessionId, input.callId);

    const workstreamId =
      this.deps.stores.sessions.get(sessionId).session.workstreamId;

    const verdict = decideApproval(ask, {
      actor: input.actor,
      sessionId: sessionId as SessionId,
      workstreamId: workstreamId as WorkstreamId,
      preGrants: approvals?.preGrantsFor(sessionId, workstreamId) ?? [],
      approval: existing ?? null,
    });

    if (verdict.kind === "denied") {
      throw refused({
        reason: "integration_write_denied",
        message: verdict.reason,
      });
    }
    if (verdict.kind === "must-ask") {
      if (approvals === undefined) {
        throw forbidden(
          `${verdict.reason} — and no approval authority is wired, so there is nobody to raise it for`,
        );
      }
      const approval = approvals.raise({
        sessionId,
        workstreamId,
        ask,
        callId: input.callId,
        pierced: verdict.pierced,
      });
      return { kind: "must-ask", approval };
    }
    return { kind: "allowed" };
  }

  private requireProducer(producerId: string): draft.DraftConceptProducer {
    const producer = this.deps.registry.get(producerId);
    if (producer === undefined) {
      throw notFound(`unknown integration producer ${producerId}`);
    }
    return producer;
  }
}

/**
 * What object a read-back should target: the action's own `readBack`, or the
 * `externalId` the caller's input named (most write actions take one) — never
 * invented, because a read-back that guessed the wrong object would be worse
 * than none.
 */
function readBackExternalId(
  result: draft.DraftWriteResult,
  actionInput: unknown,
): string | null {
  if (result.readBack !== null) return result.readBack.externalId;
  if (
    typeof actionInput === "object" &&
    actionInput !== null &&
    "externalId" in actionInput &&
    typeof (actionInput as { externalId: unknown }).externalId === "string"
  ) {
    return (actionInput as { externalId: string }).externalId;
  }
  return null;
}
