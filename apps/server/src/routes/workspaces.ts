import { Hono } from "hono";
import { notFound } from "../http/errors.js";
import {
  readWorkspaceDiff,
  type WorkspaceDiffDeps,
} from "../workspaces/diff.js";
import { param, type ApiEnv, type ApiStores } from "./api.js";

/**
 * The workspace read surface (§3.4, §11).
 *
 * One endpoint for now: the diff the Diff panel renders — "a workspace's changes
 * — file tree and patches, read-only". It is a GET and every git invocation
 * behind it is a read; there is no write verb in this file, and the host-auth
 * invariant holds by construction because the reads go through `runGit`.
 *
 * Not-ready states are answers rather than empty successes: a workstream with no
 * workspace, a record with nothing checked out, and a checkout git cannot read are
 * three different facts, and the response names which (§3.4's "the reason is
 * visible", principle 12's "never quietly drop").
 */
export function workspaceRoutes(
  stores: ApiStores,
  deps: WorkspaceDiffDeps,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get("/workstreams/:id/diff", async (c) => {
    const id = param(c, "id");
    // An id naming no workstream is the same 404 every other workstream read
    // reports, rather than an empty diff that reads as "no changes".
    if (stores.workstreams.get(id) === undefined) {
      throw notFound(`unknown workstream ${id}`);
    }

    return c.json(
      await readWorkspaceDiff(deps, stores.workspaces.forWorkstream(id)),
    );
  });

  return app;
}
