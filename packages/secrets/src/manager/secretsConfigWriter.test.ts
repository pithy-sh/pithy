import type { CloudflareSecretsStoreManager } from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
import { describe, expect, test, vi } from "vitest";
import { rotationConfigWriter } from "./secretsConfigWriter";

/** A fake Secrets Store manager exposing only `putSecret`, with a spy. */
function fakeManager() {
  const putSecret = vi.fn(async () => {});
  return { manager: { putSecret } as unknown as CloudflareSecretsStoreManager, putSecret };
}

describe("rotationConfigWriter", () => {
  // Regression guard for the rotation write-back: it must target the env-prefixed master-key entry
  // the worker binds, never the unprefixed default. Targeting the wrong entry persists the rotated
  // key set where the binding never reads it, leaving re-encrypted rows undecryptable.
  test("staging rotation writes back to STAGING_SECRETS_ENCRYPTION_KEYS", async () => {
    const { manager, putSecret } = fakeManager();
    await rotationConfigWriter(manager, "staging").write("new-config");
    expect(putSecret).toHaveBeenCalledWith("STAGING_SECRETS_ENCRYPTION_KEYS", "new-config");
  });

  test("production rotation writes back to PRODUCTION_SECRETS_ENCRYPTION_KEYS", async () => {
    const { manager, putSecret } = fakeManager();
    await rotationConfigWriter(manager, "production").write("c");
    expect(putSecret).toHaveBeenCalledWith("PRODUCTION_SECRETS_ENCRYPTION_KEYS", "c");
  });

  test("rejects an unknown environment — the wrangler ENVIRONMENT var is validated", () => {
    const { manager } = fakeManager();
    expect(() => rotationConfigWriter(manager, "staging-typo")).toThrow();
  });
});
