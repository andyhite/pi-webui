import type { ApiStores } from "../routes/api.js";

/**
 * Keep a session findable (§6.8): re-derive its title, location, and content
 * from its own record, and write them into the FTS index.
 *
 * Called at the moments the transcript itself would version — session start
 * (so a session is findable from the moment it exists, before it has said
 * anything) and checkpoint/session-end (so its content catches up) — never
 * per turn. That is the same boundary §3.6's checkpoint rule draws for the
 * transcript, deliberately: indexing per turn would mean tokenizing every
 * streamed token, and the checkpoint rule already says what "new content
 * worth a version" means for this exact object.
 *
 * "Archived" is never written here. It is a fact about the session's
 * *workstream* (§3.3's archive gesture), read fresh at query time by the
 * search route — so a workstream archived after a session was last indexed is
 * still reported as archived correctly, rather than the index silently
 * agreeing with whatever was true when it was last written (§6.8: "archived
 * sessions are reported as archived rather than hidden").
 */
export function reindexSessionSearch(
  stores: ApiStores,
  sessionId: string,
): void {
  const stored = stores.sessions.get(sessionId);
  const workstream = stores.workstreams.get(stored.session.workstreamId);

  const location =
    workstream?.subjectObjectId != null
      ? (stores.objects.get(workstream.subjectObjectId)?.title ??
        `workstream ${stored.session.workstreamId}`)
      : `workstream ${stored.session.workstreamId}`;

  const title = resolveSessionTitle(stores, stored.session.commandId);

  const body =
    stored.transcriptObjectId === null
      ? ""
      : stores.objects.read(stored.transcriptObjectId).renderings.agentContent;

  stores.search.index({
    title,
    location,
    body,
    kind: "session",
    refKind: "session",
    refId: sessionId,
  });
}

/**
 * A producing session's title is its command definition's name — the same
 * identity a run's own history and preview render (§3.5). An open session (no
 * command) or a definition that no longer resolves (deleted, or the lookup
 * disagrees for any other reason) falls back to a stated default rather than
 * throwing: reindexing must never be why a session write fails.
 */
function resolveSessionTitle(
  stores: ApiStores,
  commandId: string | null,
): string {
  if (commandId === null) return "Open session";
  try {
    const command = stores.commands.command(commandId);
    return stores.commands.definition(command.definitionId).name;
  } catch {
    return "Open session";
  }
}
