// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initialVersionedValue } from "./crypto/versionedValue";
import type { SecretsStoreEnv } from "./env/bindings";
import { SecretCryptoError, SecretNotFoundError } from "./error/errors";
import { defineSecretRegistry, type SecretRegistry } from "./registry";
import { type KeyedSecretIO, SecretsAccessor } from "./secretsStore";
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

  test("throws when one capability declares a name keyed and another declares it named", () => {
    const named = defineSecretRegistry({
      CONNECTION_SIGNING_KEY: { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    });
    const keyed = defineSecretRegistry({
      CONNECTION_SIGNING_KEY: { backend: "d1", scope: "environment", rotatable: true, valueType: "text", keyed: true },
    });
    const a = defineCapability({ name: "connections", requiredBindings: [], secretRegistry: named });
    const b = defineCapability({ name: "rogue", requiredBindings: [], secretRegistry: keyed });
    expect(() => aggregateSecretRegistries([a, b])).toThrowError(/declared incompatibly/);
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

describe("sharedSecretsStore — an unset secret in one capability, a read in another (#170)", () => {
  // The reproduction, end to end and through the real resolver: two capabilities compose, one of them
  // declares a credential that is only needed when its provider is enabled, and nothing sets it. Every
  // entry here is `cf-secrets-store`, so the Node project needs no D1 — the seam under test is the
  // combined registry, not the backend.
  const authSlice = defineSecretRegistry({
    "auth-session-secret": { backend: "cf-secrets-store", scope: "environment", rotatable: true, valueType: "text" },
    "auth-google-credentials": {
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: false,
      valueType: "text",
      notes: "Read only when the provider is enabled.",
    },
  });
  const paymentsSlice = defineSecretRegistry({
    "payments-webhook-secret": {
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: true,
      valueType: "text",
    },
  });

  /** A worker env with the two configured secrets bound, and the optional one absent. */
  const workerEnv = {
    SECRETS: undefined,
    SECRETS_ENCRYPTION_KEYS: "",
    "auth-session-secret": "sess",
    "payments-webhook-secret": "whsec",
  } as unknown as SecretsStoreEnv;

  function composed(): void {
    const auth = defineCapability({ name: "auth", requiredBindings: [], secretRegistry: authSlice });
    const payments = defineCapability({ name: "payments", requiredBindings: [], secretRegistry: paymentsSlice });
    // The real `secretsStore` — no `resolve` seam. The whole point is that the resolution succeeds.
    configureSharedSecrets({ registry: aggregateSecretRegistries([auth, payments]) });
  }

  test("both capabilities read their own configured secret", async () => {
    composed();
    expect((await sharedSecretsStore(workerEnv, authSlice)).get("auth-session-secret")).toBe("sess");
    expect((await sharedSecretsStore(workerEnv, paymentsSlice)).get("payments-webhook-secret")).toBe("whsec");
  });

  test("the unset one still fails when it is the secret actually read, and it names itself", async () => {
    composed();
    const accessor = await sharedSecretsStore(workerEnv, authSlice);
    const error = (() => {
      try {
        accessor.get("auth-google-credentials");
      } catch (e: unknown) {
        return e;
      }
      throw new Error("expected the read to throw");
    })();
    expect(error).toBeInstanceOf(SecretNotFoundError);
    expect(JSON.stringify((error as SecretNotFoundError).payload)).toContain("auth-google-credentials");
  });
});

describe("sharedSecretsStore — keyspaces", () => {
  const keyspace = defineSecretRegistry({
    CONNECTION_SIGNING_KEY: { backend: "d1", scope: "environment", rotatable: true, valueType: "text", keyed: true },
  });

  /** A stale keyed seam — the one a previous request's accessor was built with. */
  const staleIO: KeyedSecretIO = {
    read: async () => initialVersionedValue("from-a-previous-request"),
    write: async () => "1",
    remove: async () => {},
  };

  test("a keyed read uses the calling invocation's env, not the one that filled the cache", async () => {
    // The cached accessor carries the I/O built when it was resolved — a previous request's env.
    // A keyspace read is real I/O, so the shared store rebinds it to this invocation's env; here that
    // means the bare `env` above, whose missing master key surfaces as a crypto fault. Were the stale
    // seam used instead, this would quietly return "from-a-previous-request".
    configureSharedSecrets({
      registry: keyspace,
      resolve: async () => new SecretsAccessor(keyspace, {}, staleIO),
      now: () => 0,
    });

    const accessor = await sharedSecretsStore(env, keyspace);

    await expect(accessor.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).rejects.toBeInstanceOf(SecretCryptoError);
  });

  test("a keyed write uses the calling invocation's env too", async () => {
    // The same argument, and it matters more on a write: a member sealed through a stale master key
    // is a row nothing in this environment can open, and nothing would say so until a later read.
    configureSharedSecrets({
      registry: keyspace,
      resolve: async () => new SecretsAccessor(keyspace, {}, staleIO),
      now: () => 0,
    });

    const accessor = await sharedSecretsStore(env, keyspace);

    await expect(accessor.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", "minted")).rejects.toBeInstanceOf(
      SecretCryptoError,
    );
  });
});
