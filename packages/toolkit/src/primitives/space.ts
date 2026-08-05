/**
 * §18's space scale (`tokens.ts`), typed as the union of steps rather than a
 * number: the scale is non-linear (4 · 6 · 8 · 9 · 11 · 12 · 14 · 16 · 18 ·
 * 20 · 24 · 28), so nothing here accepts a pixel value or interpolates one —
 * a caller names a step, the same way it names a variant.
 */
export type Space = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** `Space` step -> the custom property that holds it. Undefined stays unset. */
export function spaceVar(step: Space | undefined): string | undefined {
  return step === undefined ? undefined : `var(--pr-space-${step})`;
}
