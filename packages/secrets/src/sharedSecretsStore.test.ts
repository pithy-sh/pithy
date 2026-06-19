import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defineSecretRegistry, type SecretRegistry } from "./registry";
import { SecretsAccessor } from "./secretsStore";
import {
  aggregateSecretRegistries,
  configureSharedSecrets,
  DEFAULT_SECRETS_CACHE_TTL_SECONDS,
  resetSharedSecrets,
  sharedSecretsStore,
} from "./sharedSecretsStore";

/** A bare env — the fake resolver never touches it, so its shape is irrelevant here. */
const env = {} as Parameters<typeof sharedSecretsStore>[0];

const apiToken = defineSecretRegistry({
  CLOUDFLARE_API_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text" },
});
const signingKey = defineSecretRegistry({
  "email-link-signing-key": { backend: "d1", scope: "global", rotatable: true, valueType: "text" },
});

/** Build a real accessor over `registry`, every name resolved to `value`, for the fake resolver to return. */
function fakeAccessor<R extends SecretRegistry>(registry: R, value: string): SecretsAccessor<R> {
  const resolved = Object.fromEntries(
    Object.keys(registry).map((name) => [name, { current: value, currentVersion: "1", versions: { "1": value } }]),
  );
  return new SecretsAccessor(registry, resolved);
}

afterEach(() => resetSharedSecrets());

describe("aggregateSecretRegistries", () => {
  test("merges every capability's slice into one combined registry", () => {
    const a = defineCapability({ name: "secrets", requiredBindings: [], secretRegistry: apiToken });
    const b = defineCapability({ name: "email", requiredBindings: [], secretRegistry: signingKey });
    const c = defineCapability({ name: "stateless", requiredBindings: [] });
    const combined = aggregateSecretRegistries([a, b, c]);
    expect(Object.keys(combined).sort()).toEqual(["CLOUDFLARE_API_TOKEN", "email-link-signing-key"]);
  });

  test("allows the same secret name when declarations agree on every axis", () => {
    const a = defineCapability({ name: "secrets", requiredBindings: [], secretRegistry: signingKey });
    const b = defineCapability({ name: "email", requiredBindings: [], secretRegistry: signingKey });
    expect(() => aggregateSecretRegistries([a, b])).not.toThrow();
  });

  test("throws on a divergent re-declaration of the same secret name", () => {
    const a = defineCapability({ name: "email", requiredBindings: [], secretRegistry: signingKey });
    const divergent = defineSecretRegistry({
      "email-link-signing-key": { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text" },
    });
    const b = defineCapability({ name: "rogue", requiredBindings: [], secretRegistry: divergent });
    expect(() => aggregateSecretRegistries([a, b])).toThrowError(/declared incompatibly/);
  });
});

describe("sharedSecretsStore", () => {
  test("resolves the combined registry once and shares it across capabilities (TTL hit)", async () => {
    const combined = { ...apiToken, ...signingKey };
    const resolve = vi.fn(async () => fakeAccessor(combined, "v"));
    configureSharedSecrets({ registry: combined, ttlSeconds: 60, resolve, now: () => 0 });

    const first = await sharedSecretsStore(env, apiToken);
    const second = await sharedSecretsStore(env, signingKey);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(first.get("CLOUDFLARE_API_TOKEN")).toBe("v");
    expect(second.get("email-link-signing-key")).toBe("v");
  });

  test("returns a precisely-typed view over only the requested slice", async () => {
    const combined = { ...apiToken, ...signingKey };
    configureSharedSecrets({ registry: combined, resolve: async () => fakeAccessor(combined, "v"), now: () => 0 });
    const accessor = await sharedSecretsStore(env, apiToken);
    // The view resolves its own slice from the shared resolution; its type is the requested slice, so
    // a name outside it ("email-link-signing-key") is a compile error rather than a runtime miss.
    expect(accessor.get("CLOUDFLARE_API_TOKEN")).toBe("v");
  });

  test("re-fetches after the TTL expires", async () => {
    let clock = 0;
    const resolve = vi.fn(async () => fakeAccessor(apiToken, "v"));
    configureSharedSecrets({ registry: apiToken, ttlSeconds: 60, resolve, now: () => clock });

    await sharedSecretsStore(env, apiToken); // first fetch at t=0, expires at t=60_000
    clock = 30_000;
    await sharedSecretsStore(env, apiToken); // within TTL → cached
    expect(resolve).toHaveBeenCalledTimes(1);

    clock = 60_001; // past expiry
    await sharedSecretsStore(env, apiToken);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test("de-duplicates a concurrent first fetch into one resolution", async () => {
    const resolve = vi.fn(async () => fakeAccessor(apiToken, "v"));
    configureSharedSecrets({ registry: apiToken, resolve, now: () => 0 });
    await Promise.all([sharedSecretsStore(env, apiToken), sharedSecretsStore(env, apiToken)]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test("throws when a requested secret was never aggregated (capability forgot its slice)", async () => {
    configureSharedSecrets({ registry: apiToken, resolve: async () => fakeAccessor(apiToken, "v"), now: () => 0 });
    await expect(sharedSecretsStore(env, signingKey)).rejects.toThrowError(/not in the aggregated registry/);
  });

  test("throws when the shared accessor was never configured", async () => {
    await expect(sharedSecretsStore(env, apiToken)).rejects.toThrowError(/not configured/);
  });

  test("defaults the TTL to 60 seconds", () => {
    expect(DEFAULT_SECRETS_CACHE_TTL_SECONDS).toBe(60);
  });
});
