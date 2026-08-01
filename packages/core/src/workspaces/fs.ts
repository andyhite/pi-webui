/**
 * The directory-listing seam.
 *
 * Discovery scans configured search paths (§3.4), which means reading
 * directories — the one filesystem capability the domain needs and the one it
 * therefore takes as a dependency rather than importing. Unit tests pass a map
 * of directories; the server passes the real filesystem.
 */

export interface DirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
}

export interface WorkspaceFs {
  /** Rejects, or reports unreadable, rather than pretending a path is empty. */
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;
}
