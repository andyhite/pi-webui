import { join } from "node:path";

/**
 * The state directory is the unit of portability (spec §12): the database and
 * the external blob files live together, so copying the directory moves all
 * durable state. Nothing outside this directory is state.
 */
export interface StateLayout {
  readonly dir: string;
  readonly databaseFile: string;
  readonly blobsDir: string;
}

export function stateLayout(dir: string): StateLayout {
  return {
    dir,
    databaseFile: join(dir, "plotroom.db"),
    blobsDir: join(dir, "blobs"),
  };
}

/**
 * External blobs are content-addressed and fanned out two hex characters deep,
 * so no single directory accumulates every file.
 */
export function blobPath(blobsDir: string, hash: string): string {
  return join(blobsDir, hash.slice(0, 2), hash.slice(2));
}
