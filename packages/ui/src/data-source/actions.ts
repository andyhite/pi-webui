/**
 * The mutation half of talking to the real server (Sync 2): every gesture
 * the canvas already offers — placing an object, wiring context, creating a
 * workstream, writing a note — goes through the same `/api` endpoints an
 * agent tool will (principle 8), over the same same-origin `HttpClient`.
 *
 * A 409 is a refusal, not a failure: `checkConnection`'s reason travels back
 * from the server verbatim (Epic 2.2, `apps/server/src/http/domain-errors.ts`),
 * and this module turns it into a typed `{ ok: false, refusal }` a caller
 * can show — never a caught-and-ignored exception, and never treated as the
 * gesture having succeeded. Anything else (network failure, a genuine server
 * error) is not a refusal and is left to throw, because pretending an
 * unrelated failure was "the answer is no" would hide a real bug.
 */

import type { NodeRole } from "@plotroom/core";

import { HttpError, type HttpClient } from "../transport/http.js";

export interface ApiRefusal {
  readonly reason: string;
  readonly message: string;
}

export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ApiRefusal };

async function asAction<T>(call: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    if (err instanceof HttpError && err.isRefusal) {
      return {
        ok: false,
        refusal: { reason: err.reason ?? "refused", message: err.message },
      };
    }
    throw err;
  }
}

export interface PlaceNodeInput {
  readonly role: NodeRole;
  readonly refId: string;
  readonly workstreamId?: string;
  readonly running?: boolean;
}

export interface AddContextEdgeInput {
  readonly from: string;
  readonly to: string;
  readonly ordinal?: number;
}

export interface CreateNoteInput {
  readonly title: string;
  readonly body: string;
  readonly workstreamId?: string;
}

export interface InstantiateCommandInput {
  readonly definitionId: string;
  readonly workstreamId: string;
  /** Existing node ids wired as context in the same gesture (§3.5). */
  readonly context?: readonly string[];
}

export interface GraphActions {
  createWorkstream(
    subjectId?: string,
  ): Promise<ActionResult<{ readonly workstreamId: string }>>;
  placeNode(
    input: PlaceNodeInput,
  ): Promise<ActionResult<{ readonly nodeId: string }>>;
  removeNode(nodeId: string): Promise<ActionResult<void>>;
  addContextEdge(
    input: AddContextEdgeInput,
  ): Promise<ActionResult<{ readonly edgeId: string }>>;
  removeEdge(edgeId: string): Promise<ActionResult<void>>;
  createNote(
    input: CreateNoteInput,
  ): Promise<ActionResult<{ readonly objectId: string }>>;
  editNote(
    objectId: string,
    input: { readonly title?: string; readonly body: string },
  ): Promise<ActionResult<void>>;
  /** A command definition dropped onto a bare ticket (§3.5, §3.3), post-workstream. */
  instantiateCommand(
    input: InstantiateCommandInput,
  ): Promise<
    ActionResult<{ readonly commandId: string; readonly nodeId: string }>
  >;
}

export function createApiActions(http: HttpClient): GraphActions {
  return {
    createWorkstream: (subjectId) =>
      asAction(async () => {
        const response = await http.post<{
          workstream: { readonly id: string };
        }>("/api/workstreams", subjectId ? { subjectId } : {});
        return { workstreamId: response.workstream.id };
      }),

    placeNode: (input) =>
      asAction(async () => {
        const response = await http.post<{ node: { readonly id: string } }>(
          "/api/nodes",
          input,
        );
        return { nodeId: response.node.id };
      }),

    removeNode: (nodeId) =>
      asAction(async () => {
        await http.delete(apiPath("/api/nodes", nodeId));
      }),

    addContextEdge: (input) =>
      asAction(async () => {
        const response = await http.post<{ edge: { readonly id: string } }>(
          "/api/edges",
          input,
        );
        return { edgeId: response.edge.id };
      }),

    removeEdge: (edgeId) =>
      asAction(async () => {
        await http.delete(apiPath("/api/edges", edgeId));
      }),

    createNote: (input) =>
      asAction(async () => {
        const response = await http.post<{
          object: { readonly id: string };
        }>("/api/notes", input);
        return { objectId: response.object.id };
      }),

    editNote: (objectId, input) =>
      asAction(async () => {
        await http.patch(apiPath("/api/notes", objectId), input);
      }),

    instantiateCommand: (input) =>
      asAction(async () => {
        const response = await http.post<{
          command: { readonly id: string };
          node: { readonly id: string };
        }>("/api/commands", input);
        return { commandId: response.command.id, nodeId: response.node.id };
      }),
  };
}

/**
 * A fixed, literal API prefix plus one path-encoded id segment — never a
 * caller-supplied URL or host (the same-origin rule `HttpClient` itself
 * enforces), and `encodeURIComponent` keeps an id containing `/` or `?`
 * from being read as extra path segments or query parameters.
 */
function apiPath(prefix: string, id: string): string {
  return `${prefix}/${encodeURIComponent(id)}`;
}
