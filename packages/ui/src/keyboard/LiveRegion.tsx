/**
 * A polite live region (§11). One element, one message at a time: whatever a
 * surface last decided is worth announcing (`announce.ts`). `aria-live
 * ="polite"` and not `assertive`, because none of these announcements
 * interrupt what the operator is doing — they report what the machine did.
 *
 * Rendered visible rather than clipped off-screen: hiding text is a visual
 * decision, and the design gate (fleet rule 5) defers those. The element is
 * `role="status"` either way, which is what a screen reader reads.
 */

export interface LiveRegionProps {
  /** The current announcement, or null/empty for "nothing to say". */
  readonly message: string | null;
  readonly label: string;
  readonly testId?: string;
}

export function LiveRegion({ message, label, testId }: LiveRegionProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={label}
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      {message ?? ""}
    </div>
  );
}
