import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `.spec.ts` here is Playwright's suffix, not vitest's — the e2e gate
    // (`e2e/milestone.spec.ts`) is a separate, explicitly-run suite (see
    // `e2e/playwright.config.ts`'s doc comment), never collected by vitest.
    include: ["src/**/*.test.ts"],
  },
});
