import {
  isApproved,
  type Author,
  type DomainEvent,
  type Integration,
  type PluginHealthState,
  type PluginIntegrationStatus,
  type PluginPermissionStatus,
  type PluginStatus,
  type PluginStatusOrigin,
  type PluginStatusState,
} from "@plotroom/core";
import {
  describePermission,
  PluginRegistry,
  type PermissionGrant,
  type PermissionId,
  type PermissionRaise,
  type PluginDescriptor,
  type PluginHost,
  type PluginId,
  type PluginInstallFailure,
  type PluginRecord,
} from "@plotroom/plugin-sdk";
import type { PluginGrantStore } from "@plotroom/db";
import type { ConditionCheckRegistry } from "../conditions/registry.js";
import type { EventBus, Unsubscribe } from "../events/bus.js";
import { badRequest, forbidden, notFound } from "../http/errors.js";
import type { IntegrationRegistry } from "../integrations/registry.js";
import type { Logger } from "../logging/logger.js";
import type { ApiStores } from "../routes/api.js";
import { hostedConditionCheckers } from "./conditions.js";
import { resolveInBoxPlugins, type InBoxPluginEntry } from "./in-box.js";
import { PluginInvoker, type InvokerApprovals } from "./invoker.js";
import { hostedContributions } from "./producers.js";

/**
 * The plugin platform, mounted (§10.2, `docs/plugin-contract.md` §8).
 *
 * One `PluginRegistry` per server, one worker per enabled plugin, and this class as
 * the wiring the contract doc's §8 specifies: a credential resolver, `grantsFor`
 * from the persisted grant rows, `onEvent` onto the one event stream, in-box entries
 * installed at boot plus a configured plugins directory, and the four lifecycle
 * verbs reachable without restarting anything.
 *
 * ## What it decides: nothing
 *
 * Health, conformance, versioning, restarts, permission gating, credential
 * injection and redaction are the host's. Which producers exist and what they
 * declare is the plugin's. Whether an integration is connected is
 * `IntegrationStore`'s. This class joins them — and the join is the part §10.2 asks
 * for that neither side could do alone: **a plugin's contributions reach the
 * substrate when it is enabled and leave when it is disabled**, which is what makes
 * "install / enable / disable / remove, per plugin, without restarting" true of the
 * product rather than of the registry in isolation.
 *
 * ## Operator-only, enforced by the request's actor
 *
 * Every lifecycle verb and every grant is the operator's act (principle 1: there is
 * no agent tool that grants a permission, for the same reason there is none that
 * raises a budget). The enforcement is {@link PluginService.requireOperator},
 * mirroring `ClaimService`/`IntegrationService`'s own convention — the request's
 * actor, not a flag in the tool catalog that merely describes the intent.
 *
 * ## A failure is a state with a reason
 *
 * `boot()` never throws for a plugin: an unresolvable in-box package, an unreadable
 * manifest, a plugin that throws on load are all reported — as an install failure or
 * as `unavailable` health with the host's own sentence — while the server keeps
 * serving and every other plugin keeps answering (§10.2). That is Batch 5's exit
 * criterion, and `plugins.integration.test.ts` is the test that names it.
 */
export interface PluginServiceDeps {
  readonly stores: ApiStores;
  readonly grants: PluginGrantStore;
  readonly bus: EventBus;
  readonly logger: Logger;
  /** Where a plugin's producers and write actions land while it is enabled. */
  readonly integrations: IntegrationRegistry;
  /** Where a plugin's condition checks land while it is enabled (§4.3). */
  readonly conditions?: ConditionCheckRegistry;
  /** §6.6, for the permission raise. Absent means nothing can be asked. */
  readonly approvals?: InvokerApprovals;
  /** The in-box list; overridable so a test can mount fixtures instead. */
  readonly inBox?: readonly InBoxPluginEntry[];
  /** §10.2's configured plugins directory. Null means none is configured. */
  readonly directory?: string | null;
  /** Per-plugin host options, for tests that need shorter timeouts. */
  readonly hostOptions?: {
    readonly loadTimeoutMs?: number;
    readonly callTimeoutMs?: number;
  };
}

export class PluginService {
  readonly #registry: PluginRegistry;
  readonly #invoker: PluginInvoker;
  readonly #failures: PluginInstallFailure[] = [];
  /**
   * Which permission an approval was raised for, so approving it grants that
   * permission. Remembered for the lifetime of the process, which is the lifetime
   * of the call it blocks: a restart interrupts a blocked call (principle 11), and
   * the operator's own grant route is the durable path.
   */
  readonly #raised = new Map<string, PermissionRaise>();
  #unsubscribe: Unsubscribe | null = null;

  constructor(private readonly deps: PluginServiceDeps) {
    this.#registry = new PluginRegistry({
      host: {
        ...(deps.hostOptions ?? {}),
        // §9.3: the host holds the secret and injects it per call, for granted
        // names only. A granted credential nothing has stored refuses the call
        // saying so — a broken connection is an integration health problem, never
        // mysteriously missing data.
        credentials: (request) => this.credential(request),
      },
      grantsFor: (pluginId) => this.grantsFor(pluginId),
      onEvent: (event) => {
        const record = this.#registry.get(event.pluginId);
        if (record === null) return; // removal publishes its own `deleted`.
        this.publish(record, "updated");
      },
      now: () => this.deps.stores.clock() * 1000,
    });
    this.#invoker = new PluginInvoker({
      logger: deps.logger,
      host: (pluginId) => this.#registry.host(pluginId as PluginId),
      ...(deps.approvals === undefined ? {} : { approvals: deps.approvals }),
      onRaised: ({ approval, raise }) => {
        this.#raised.set(approval.id, raise);
      },
    });
  }

  /** The invoker every host-backed contribution calls through. */
  get invoker(): PluginInvoker {
    return this.#invoker;
  }

  /**
   * Install the in-box entries and the configured directory, then enable each.
   *
   * Enabling at boot is not a schedule and initiates nothing (principle 2): a
   * plugin's worker answers when something asks it to, and an in-box plugin nobody
   * enabled would be a product whose GitHub integration silently did not exist.
   */
  async boot(): Promise<readonly PluginStatus[]> {
    for (const resolution of resolveInBoxPlugins(this.deps.inBox)) {
      if (!resolution.ok) {
        this.#failures.push({
          entry: resolution.packageName,
          origin: "in-box",
          reason: resolution.reason,
        });
        this.deps.logger.warn("in-box plugin could not be resolved", {
          pluginId: resolution.pluginId,
          reason: resolution.reason,
        });
        continue;
      }
      const result = await this.#registry.install(resolution.entry, "in-box");
      if (!result.installed) {
        this.#failures.push(result.failure);
        this.deps.logger.warn("in-box plugin failed to install", {
          pluginId: resolution.pluginId,
          reason: result.failure.reason,
        });
      }
    }

    const directory = this.deps.directory ?? null;
    if (directory !== null) {
      // A scan is a read the operator configured, never a timer (principle 2).
      const scanned = await this.#registry.installFromDirectory(directory);
      this.#failures.push(...scanned.failures);
      for (const failure of scanned.failures) {
        this.deps.logger.warn(
          "plugin in the plugins directory failed to install",
          {
            entry: failure.entry,
            reason: failure.reason,
          },
        );
      }
    }

    for (const record of this.#registry.list()) {
      await this.enableRecord(record.id);
    }

    this.#unsubscribe = this.deps.bus.subscribe((event) => {
      this.onEvent(event);
    });

    return this.list();
  }

  /** Stop every worker. Nothing on disk is touched (principle 10). */
  async shutdown(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.#registry.disposeAll();
  }

  /* ------------------------------------------------------- the health surface */

  /** §10.2's health surface, whole: `GET /api/plugins` returns exactly this. */
  list(): readonly PluginStatus[] {
    return this.#registry.list().map((record) => this.statusOf(record));
  }

  get(pluginId: string): PluginStatus {
    const record = this.#registry.get(pluginId as PluginId);
    if (record === null) throw notFound(`no plugin named ${pluginId}`);
    return this.statusOf(record);
  }

  /**
   * What could not be installed at all, reported rather than dropped (principle
   * 12). These have no `PluginStatus` because there is no manifest behind them —
   * a plugin whose manifest could not be read has no id, name, or version to state.
   */
  failures(): readonly PluginInstallFailure[] {
    return [...this.#failures];
  }

  /* ----------------------------------------------------------- the four verbs */

  async install(entry: string, actor: Author): Promise<PluginStatus | null> {
    this.requireOperator(actor, "installing a plugin");
    const result = await this.#registry.install(entry, "directory");
    if (!result.installed) {
      this.#failures.push(result.failure);
      return null;
    }
    this.publish(result.record, "created");
    return this.statusOf(result.record);
  }

  /** Re-scan the configured plugins directory on the operator's gesture (§10.2). */
  async scanDirectory(actor: Author): Promise<readonly PluginStatus[]> {
    this.requireOperator(actor, "scanning the plugins directory");
    const directory = this.deps.directory ?? null;
    if (directory === null) {
      throw badRequest(
        "no plugins directory is configured (PLOTROOM_PLUGINS_DIR); in-box plugins need no scan",
      );
    }
    const scanned = await this.#registry.installFromDirectory(directory);
    this.#failures.push(...scanned.failures);
    for (const record of scanned.installed) {
      this.publish(record, "created");
    }
    return scanned.installed.map((record) => this.statusOf(record));
  }

  async enable(pluginId: string, actor: Author): Promise<PluginStatus> {
    this.requireOperator(actor, "enabling a plugin");
    this.require(pluginId);
    return this.enableRecord(pluginId);
  }

  async disable(pluginId: string, actor: Author): Promise<PluginStatus> {
    this.requireOperator(actor, "disabling a plugin");
    this.require(pluginId);
    this.unwire(pluginId);
    const record = await this.#registry.disable(pluginId as PluginId);
    return this.statusOf(record);
  }

  /** Forget it. Deletes nothing on disk — the directory is the operator's (§10.2). */
  async remove(pluginId: string, actor: Author): Promise<void> {
    this.requireOperator(actor, "removing a plugin");
    this.require(pluginId);
    this.unwire(pluginId);
    await this.#registry.remove(pluginId as PluginId);
    this.deps.grants.clear(pluginId);
    this.deps.bus.publish({
      entity: "plugin",
      verb: "deleted",
      pluginId,
      author: { kind: "human" },
    });
  }

  /* --------------------------------------------------------------- the grants */

  /**
   * Record the operator's answer about one declared permission (§10.2).
   *
   * `null` removes the row: the permission goes back to `never-asked` and may raise
   * again. There are two states and an absence, never a third state — the same
   * "grant or remove" shape budgets use.
   */
  answerGrant(
    pluginId: string,
    permissionId: string,
    state: "granted" | "denied" | null,
    actor: Author,
  ): PluginStatus {
    this.requireOperator(actor, "answering a plugin's permission request");
    const record = this.require(pluginId);
    const declared = record.descriptor.permissions.some(
      (request) => request.id === permissionId,
    );
    if (!declared) {
      throw notFound(
        `${pluginId} declares no permission ${permissionId}; a grant for one it never asked for would widen nothing and describe nothing`,
      );
    }
    if (state === null) {
      this.deps.grants.remove(pluginId, permissionId);
    } else {
      this.deps.grants.answer({ pluginId, permissionId, state });
    }
    // Takes effect on the next call; nothing is re-run (contract §4).
    this.#registry
      .host(pluginId as PluginId)
      ?.setGrants(this.grantsFor(pluginId));
    const current = this.require(pluginId);
    this.publish(current, "updated");
    return this.statusOf(current);
  }

  /* ------------------------------------------------------------------ internals */

  /**
   * An answered §6.6 approval that was a permission raise **is** the operator's
   * grant act: it was their answer to "may this plugin do X", and re-asking them
   * through a second surface would be asking the same question twice. A denial is
   * recorded as `denied` so it raises nothing again — it was answered.
   */
  private onEvent(event: DomainEvent): void {
    if (event.entity !== "approval" || event.verb !== "updated") return;
    const raise = this.#raised.get(event.approval.id);
    if (raise === undefined) return;
    if (event.approval.answer === null) return;
    this.#raised.delete(event.approval.id);
    const state = isApproved(event.approval) ? "granted" : "denied";
    this.deps.grants.answer({
      pluginId: raise.pluginId,
      permissionId: raise.permissionId,
      state,
    });
    this.#registry
      .host(raise.pluginId)
      ?.setGrants(this.grantsFor(raise.pluginId));
    this.deps.logger.info("plugin permission answered through an approval", {
      pluginId: raise.pluginId,
      permissionId: raise.permissionId,
      state,
    });
    const record = this.#registry.get(raise.pluginId);
    if (record !== null) this.publish(record, "updated");
  }

  private async enableRecord(pluginId: string): Promise<PluginStatus> {
    const record = await this.#registry.enable(pluginId as PluginId);
    const host = this.#registry.host(pluginId as PluginId);
    if (host !== null) {
      // Health arrives on its own event; waiting for it here is what lets the
      // contributions be wired from the descriptor the worker actually sent.
      await host.settled();
      this.wire(host);
    }
    const current = this.#registry.get(pluginId as PluginId) ?? record;
    return this.statusOf(current);
  }

  /** Put an enabled plugin's contributions where the substrate looks for them. */
  private wire(host: PluginHost): void {
    const descriptor = host.descriptor;
    if (descriptor === null || host.health.status !== "ready") return;

    const hosted = hostedContributions({
      descriptor,
      invoker: this.#invoker,
      workstreamOf: (sessionId) => this.workstreamOf(sessionId),
    });
    for (const producer of hosted.producers) {
      this.deps.integrations.register(producer);
    }
    for (const name of hosted.unreadable) {
      this.deps.logger.warn("plugin contribution declaration was unreadable", {
        pluginId: descriptor.id,
        contribution: name,
      });
    }
    const conditions = this.deps.conditions;
    if (conditions !== undefined) {
      for (const checker of hostedConditionCheckers({
        descriptor,
        invoker: this.#invoker,
      })) {
        conditions.register(checker);
      }
    }
  }

  /** Take them away again: disabled means unreachable, not merely stopped. */
  private unwire(pluginId: string): void {
    const record = this.#registry.get(pluginId as PluginId);
    if (record === null) return;
    for (const contribution of record.descriptor.contributions) {
      if (contribution.point === "concept-producer") {
        this.deps.integrations.unregister(contribution.id);
      }
      if (contribution.point === "condition-check") {
        this.deps.conditions?.unregister(contribution.id);
      }
    }
  }

  private grantsFor(pluginId: PluginId | string): readonly PermissionGrant[] {
    return this.deps.grants.forPlugin(String(pluginId)).map((grant) => ({
      pluginId: grant.pluginId as PluginId,
      permissionId: grant.permissionId as PermissionId,
      state: grant.state,
      answeredAt: grant.answeredAt,
    }));
  }

  /**
   * The credential a granted permission names (§9.3).
   *
   * A credential lives on an **integration** (migration 24), because that is where
   * the operator entered it in the connect flow; a plugin's permission names it by
   * id and system. So the lookup is narrowed twice before any value is read: only
   * plugins that **declared exactly this (id, system) pair** are candidates, and
   * only integrations of those plugins are searched — "exposed to no session and no
   * other plugin" (§9.3) is enforced by which rows are eligible, not by trusting the
   * asker. Nothing here hands a value to a caller that could put it in a response:
   * the only consumer is the host's per-call injection, which redacts it back out.
   */
  private credential(request: {
    readonly credentialId: string;
    readonly system: string;
  }): string | null {
    const declaredBy = new Set(
      this.#registry
        .list()
        .filter((record) =>
          record.descriptor.permissions.some(
            (permission) =>
              permission.scope.kind === "credential" &&
              permission.scope.credentialId === request.credentialId &&
              permission.scope.system === request.system,
          ),
        )
        .map((record) => String(record.id)),
    );
    for (const integration of this.deps.stores.integrations.list()) {
      if (!declaredBy.has(integration.pluginId)) continue;
      const value = this.deps.stores.credentials.reveal(
        integration.id,
        request.credentialId,
      );
      if (value !== null) return value;
    }
    return null;
  }

  private workstreamOf(sessionId: string): string | null {
    try {
      return this.deps.stores.sessions.get(sessionId).session.workstreamId;
    } catch {
      return null;
    }
  }

  private require(pluginId: string): PluginRecord {
    const record = this.#registry.get(pluginId as PluginId);
    if (record === null) throw notFound(`no plugin named ${pluginId}`);
    return record;
  }

  /**
   * A session cannot install, enable, disable, remove, or grant (principle 1,
   * §10.2). Enforced by the request's actor, the same convention
   * `ClaimService.requireOperator` and `IntegrationService.requireOperator` use.
   */
  private requireOperator(actor: Author, gesture: string): void {
    if (actor.kind === "human") return;
    throw forbidden(
      `${gesture} is the operator's gesture; a session cannot make it (§10.2, principle 1)`,
    );
  }

  private publish(record: PluginRecord, verb: "created" | "updated"): void {
    this.deps.bus.publish({
      entity: "plugin",
      verb,
      status: this.statusOf(record),
      // The app's own observation, like every other derived event on this stream
      // (`AttentionService.refresh`'s default): a plugin degrading is nobody's
      // gesture, and there is no third author kind to invent for it.
      author: { kind: "human" },
    });
  }

  private statusOf(record: PluginRecord): PluginStatus {
    const health = record.health;
    const state: PluginStatusState = record.state;
    const healthState: PluginHealthState =
      health === null ? "disabled" : health.status;
    return {
      pluginId: record.id,
      name: record.descriptor.name,
      version: record.descriptor.version,
      contractVersion: record.descriptor.contractVersion,
      origin: record.origin as PluginStatusOrigin,
      state,
      health: healthState,
      reason:
        health === null
          ? null
          : health.status === "unavailable"
            ? health.reason
            : health.status === "restarting"
              ? health.reason
              : null,
      warnings: health?.status === "ready" ? health.warnings : [],
      permissions: this.permissionsOf(record.descriptor),
      contributions: record.descriptor.contributions.map((contribution) => ({
        point: contribution.point,
        id: contribution.id,
      })),
      integrations: this.integrationsOf(record.descriptor),
      installedAt: record.installedAt,
    };
  }

  private permissionsOf(
    descriptor: PluginDescriptor,
  ): readonly PluginPermissionStatus[] {
    const answers = this.deps.grants.forPlugin(descriptor.id);
    return descriptor.permissions.map((request) => {
      const answer = answers.find(
        (candidate) => candidate.permissionId === request.id,
      );
      return {
        id: request.id,
        kind: request.kind,
        reason: request.reason,
        requiredToLoad: request.requiredToLoad,
        // The sentence the plugin's own declaration produces — never a value.
        scope: describePermission(request),
        state: answer?.state ?? "never-asked",
        answeredAt: answer?.answeredAt ?? null,
      };
    });
  }

  /**
   * §10.2's "integration connection state where applicable", read off the
   * integration record rather than inferred from plugin health: a healthy plugin
   * with a broken connection is a real state, and so is the reverse.
   */
  private integrationsOf(
    descriptor: PluginDescriptor,
  ): readonly PluginIntegrationStatus[] {
    const producerIds = new Set(
      descriptor.contributions
        .filter((contribution) => contribution.point === "concept-producer")
        .map((contribution) => contribution.id),
    );
    return this.deps.stores.integrations
      .list()
      .filter(
        (integration: Integration) =>
          integration.pluginId === descriptor.id ||
          producerIds.has(integration.producerId),
      )
      .map((integration) => ({
        integrationId: integration.id,
        name: integration.name,
        producerId: integration.producerId,
        connectionState: integration.connectionState,
        lastRefreshAt: integration.lastRefreshAt,
        lastBrokenReason: integration.lastBrokenReason,
      }));
  }
}
