/**
 * The JSON this plugin packs into `Renderings.card` (§10.1's `ContentRenderer`
 * and `CardRenderer` both need it, from the object alone — see the doc comment
 * on `content-renderer.ts` for why neither may touch the filesystem again).
 *
 * `Renderings.card` is a plain string in the frozen contract; Track B's Stage 1
 * bridge (`packages/ui/src/plugins/registry.ts`'s `toCoreRenderings`) already
 * treats it as JSON-or-fallback-to-text, so packing structured metadata in here
 * is the established convention, not a new one.
 */
export type FsEntryKind = "file" | "directory";

export interface Truncation {
  readonly omittedBytes: number;
  readonly why: string;
}

export interface CardMeta {
  readonly fsKind: FsEntryKind;
  /** File: bytes on disk. Directory: total immediate entries, listed or not. */
  readonly sizeBytes: number;
  readonly truncated: Truncation | null;
}

export function encodeCardMeta(meta: CardMeta): string {
  return JSON.stringify(meta);
}

/** `null` for anything that isn't this plugin's own JSON — never a throw. */
export function decodeCardMeta(card: string): CardMeta | null {
  try {
    const parsed: unknown = JSON.parse(card);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "fsKind" in parsed &&
      "sizeBytes" in parsed
    ) {
      return parsed as CardMeta;
    }
    return null;
  } catch {
    return null;
  }
}
