/**
 * JSONL framing, shared by every adapter that talks to a child process over
 * stdio.
 *
 * LF is the only record delimiter. Node's `readline` is not usable here because
 * it also splits on U+2028/U+2029, which are legal inside JSON strings — a tool
 * argument containing one would be silently cut in half. So framing is ours.
 */
export function splitJsonLines(buffer: string): {
  readonly lines: readonly string[];
  readonly rest: string;
} {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return {
    lines: parts
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
      .filter((line) => line.trim().length > 0),
    rest,
  };
}
