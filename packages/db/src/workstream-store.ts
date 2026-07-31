import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  checkLifecycleAuthoring,
  newWorkstreamId,
  rollupAttention,
  systemClock,
  type AttentionCounts,
  type AttentionRollup,
  type Author,
  type Clock,
  type LifecycleRefusal,
  type WorkstreamStatus,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import {
  nodes,
  objects,
  workstreamEvents,
  workstreams,
  type NodeRow,
  type ObjectRow,
  type WorkstreamEventRow,
  type WorkstreamRow,
} from "./schema.js";

/** Thrown when a session tries to set lifecycle directly (§3.3). */
export class LifecycleRefused extends Error {
  constructor(readonly refusal: LifecycleRefusal) {
    super(refusal.message);
    this.name = "LifecycleRefused";
  }
}

export interface CreateWorkstreamInput {
  readonly author: Author;
  /** Optional: a subject-less scratch workstream is legal (§3.3). */
  readonly subjectId?: string;
}

export interface ListOptions {
  /** Archived workstreams are reported when asked for, never hidden (§3.3). */
  readonly includeArchived?: boolean;
}

export interface WorkstreamContents {
  readonly nodes: NodeRow[];
  readonly localObjects: ObjectRow[];
}

/**
 * Workstreams (spec §3.3): identity, isolation, zoom boundary, attention
 * rollup. Lifecycle and subject are authored and every mutation is
 * attributed in workstream_events; the product only ever *suggests* a
 * transition (the predicate lives in @plotroom/core), so nothing in this
 * store transitions on its own.
 */
export class WorkstreamStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  create(input: CreateWorkstreamInput): WorkstreamRow {
    const id = newWorkstreamId();

    this.state.db
      .insert(workstreams)
      .values({
        id,
        subjectObjectId: input.subjectId ?? null,
        status: "active",
        createdAt: this.now(),
      })
      .run();

    this.recordEvent(id, "created", input.subjectId ?? null, input.author);

    return this.workstream(id);
  }

  get(id: string): WorkstreamRow | undefined {
    return this.state.db
      .select()
      .from(workstreams)
      .where(eq(workstreams.id, id))
      .get();
  }

  /** The board: active by default; archived reported as archived on demand. */
  list(options: ListOptions = {}): WorkstreamRow[] {
    const query = this.state.db.select().from(workstreams);

    return options.includeArchived
      ? query.all()
      : query.where(isNull(workstreams.archivedAt)).all();
  }

  /** The subject is authored: dragging a ticket in names the container (§3.3). */
  setSubject(id: string, subjectId: string, author: Author): WorkstreamRow {
    this.workstream(id);

    this.state.db
      .update(workstreams)
      .set({ subjectObjectId: subjectId })
      .where(eq(workstreams.id, id))
      .run();

    this.recordEvent(id, "subject_set", subjectId, author);

    return this.workstream(id);
  }

  /**
   * Lifecycle is authored, human-only (§3.3): the predicate refuses sessions
   * toward propose-and-accept, and nothing here is ever called automatically
   * — a suggestion is a proposal the human confirms.
   */
  setStatus(
    id: string,
    status: WorkstreamStatus,
    author: Author,
  ): WorkstreamRow {
    const check = checkLifecycleAuthoring(author);
    if (!check.allowed) throw new LifecycleRefused(check.refusal);

    const current = this.workstream(id);
    if (current.status === status) return current;

    this.state.db
      .update(workstreams)
      .set({ status })
      .where(eq(workstreams.id, id))
      .run();

    this.recordEvent(id, "status_set", status, author);

    return this.workstream(id);
  }

  /**
   * The archive gesture (§3.3): the workstream leaves the board, stays
   * searchable reported as archived, and the gesture is recoverable like
   * every operation on authored state (principle 10).
   */
  archive(id: string, author: Author): WorkstreamRow {
    const check = checkLifecycleAuthoring(author);
    if (!check.allowed) throw new LifecycleRefused(check.refusal);

    const current = this.workstream(id);
    if (current.archivedAt !== null) return current;

    this.state.db
      .update(workstreams)
      .set({ archivedAt: this.now() })
      .where(eq(workstreams.id, id))
      .run();

    this.recordEvent(id, "archived", null, author);

    return this.workstream(id);
  }

  unarchive(id: string, author: Author): WorkstreamRow {
    const check = checkLifecycleAuthoring(author);
    if (!check.allowed) throw new LifecycleRefused(check.refusal);

    const current = this.workstream(id);
    if (current.archivedAt === null) return current;

    this.state.db
      .update(workstreams)
      .set({ archivedAt: null })
      .where(eq(workstreams.id, id))
      .run();

    this.recordEvent(id, "unarchived", null, author);

    return this.workstream(id);
  }

  /** The attribution trail: who set what, in order (§3.3, principle 10). */
  events(id: string): WorkstreamEventRow[] {
    return (
      this.state.db
        .select()
        .from(workstreamEvents)
        .where(eq(workstreamEvents.workstreamId, id))
        // rowid breaks same-second ties in insertion order.
        .orderBy(workstreamEvents.createdAt, sql`rowid`)
        .all()
    );
  }

  /**
   * Recompute and cache the attention rollup for the card (§3.3, §7). The
   * derivation is the core predicate; this only stores its result where the
   * collapsed card reads it. Derived state: no author, no event.
   */
  updateAttention(id: string, counts: AttentionCounts): AttentionRollup {
    this.workstream(id);

    const rollup = rollupAttention(counts);

    this.state.db
      .update(workstreams)
      .set({
        attentionStatus: rollup.status,
        attentionJson: JSON.stringify(rollup),
      })
      .where(eq(workstreams.id, id))
      .run();

    return rollup;
  }

  attention(id: string): AttentionRollup | null {
    const row = this.workstream(id);
    return row.attentionJson
      ? (JSON.parse(row.attentionJson) as AttentionRollup)
      : null;
  }

  /**
   * Containment (§3.3): the nodes placed inside the workstream — commands,
   * sessions, content — plus the local objects it owns (§3.2).
   */
  contents(id: string): WorkstreamContents {
    return {
      nodes: this.state.db
        .select()
        .from(nodes)
        .where(and(eq(nodes.workstreamId, id), isNull(nodes.deletedAt)))
        .all(),
      localObjects: this.state.db
        .select()
        .from(objects)
        .where(and(eq(objects.workstreamId, id), eq(objects.scope, "local")))
        .all(),
    };
  }

  private workstream(id: string): WorkstreamRow {
    const row = this.get(id);
    if (!row) throw new Error(`unknown workstream ${id}`);
    return row;
  }

  private recordEvent(
    workstreamId: string,
    kind: WorkstreamEventRow["kind"],
    value: string | null,
    author: Author,
  ): void {
    this.state.db
      .insert(workstreamEvents)
      .values({
        id: `wsev_${randomUUID()}`,
        workstreamId,
        kind,
        value,
        authorKind: author.kind,
        authorSession: author.kind === "session" ? author.sessionId : null,
        createdAt: this.now(),
      })
      .run();
  }
}
