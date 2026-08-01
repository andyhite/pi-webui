import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { CredentialStore } from "./credential-store.js";
import { IntegrationStore } from "./integration-store.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let credentials: CredentialStore;
let integrationId: string;

const SECRET = "sk-super-secret-token-do-not-log-me";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-credentials-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  credentials = new CredentialStore(state, clock.now);
  const integrations = new IntegrationStore(state, clock.now);
  integrationId = integrations.connect({
    pluginId: "fake-plugin",
    producerId: "fake-tickets",
    name: "Fake tickets",
    system: "fake",
  }).id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("CredentialStore", () => {
  it("stores a named credential and reveals it only through `reveal`", () => {
    credentials.put(integrationId, "api-token", SECRET);
    expect(credentials.reveal(integrationId, "api-token")).toBe(SECRET);
    expect(credentials.has(integrationId, "api-token")).toBe(true);
  });

  it("never returns the value from anything but `reveal` (api-proof, in miniature)", () => {
    credentials.put(integrationId, "api-token", SECRET);

    // `names` is the surface a connect-flow UI reads to say "connected" — it
    // must never carry the value, by construction rather than by convention.
    expect(credentials.names(integrationId)).toEqual(["api-token"]);
    expect(JSON.stringify(credentials.names(integrationId))).not.toContain(
      SECRET,
    );
    expect(
      JSON.stringify(credentials.has(integrationId, "api-token")),
    ).not.toContain(SECRET);
  });

  it("upserts rather than duplicating a named credential", () => {
    credentials.put(integrationId, "api-token", SECRET);
    credentials.put(integrationId, "api-token", "a-rotated-token");
    expect(credentials.reveal(integrationId, "api-token")).toBe(
      "a-rotated-token",
    );
    expect(credentials.names(integrationId)).toEqual(["api-token"]);
  });

  it("answers null for a credential nobody stored", () => {
    expect(credentials.reveal(integrationId, "nope")).toBeNull();
    expect(credentials.has(integrationId, "nope")).toBe(false);
  });

  it("supports more than one named secret per integration", () => {
    credentials.put(integrationId, "api-token", SECRET);
    credentials.put(integrationId, "webhook-signing-key", "whsec_123");
    expect(new Set(credentials.names(integrationId))).toEqual(
      new Set(["api-token", "webhook-signing-key"]),
    );
  });

  it("clears every credential for an integration", () => {
    credentials.put(integrationId, "api-token", SECRET);
    credentials.clear(integrationId);
    expect(credentials.names(integrationId)).toEqual([]);
    expect(credentials.reveal(integrationId, "api-token")).toBeNull();
  });
});
