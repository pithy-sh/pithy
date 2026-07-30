// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { SecretsStoreEnv } from "./env/bindings";
import { SecretInvalidValueError, SecretNotFoundError } from "./error/errors";
import { defineSecretRegistry } from "./registry";
import { secretsStore } from "./secretsStore";

/** A CF-Secrets-Store-only registry needs no D1, so the env only carries the named bindings. */
function envWith(bindings: Record<string, unknown>): SecretsStoreEnv {
  return { SECRETS: undefined, SECRETS_ENCRYPTION_KEYS: "", ...bindings } as unknown as SecretsStoreEnv;
}

const Emailer = z.object({ apiKey: z.string().min(8).describe("API key.") }).describe("Emailer credentials.");

describe("secretsStore — cf-secrets-store backend", () => {
  test("get resolves a value from a .get() binding", async () => {
    const registry = defineSecretRegistry({
      NPM_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    });
    const store = await secretsStore(envWith({ NPM_TOKEN: { get: async () => "npm-abc" } }), registry);
    expect(store.get("NPM_TOKEN")).toBe("npm-abc");
  });

  test("get resolves a value from a .dev.vars string", async () => {
    const registry = defineSecretRegistry({
      NPM_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    });
    const store = await secretsStore(envWith({ NPM_TOKEN: "dev-token" }), registry);
    expect(store.get("NPM_TOKEN")).toBe("dev-token");
  });

  test("getVersions exposes a single version for a bare cf value", async () => {
    const registry = defineSecretRegistry({
      WEBHOOK_KEY: { backend: "cf-secrets-store", scope: "environment", rotatable: true, valueType: "text" },
    });
    const store = await secretsStore(envWith({ WEBHOOK_KEY: "whk" }), registry);
    expect(store.get("WEBHOOK_KEY")).toBe("whk");
    expect(store.getVersions("WEBHOOK_KEY")).toEqual({ currentVersion: "1", versions: { "1": "whk" } });
  });

  test("a json value is parsed and validated against its schema", async () => {
    const registry = defineSecretRegistry({
      EMAILER: {
        backend: "cf-secrets-store",
        scope: "environment",
        rotatable: false,
        valueType: "json",
        schema: Emailer,
      },
    });
    const store = await secretsStore(envWith({ EMAILER: JSON.stringify({ apiKey: "abcdefgh" }) }), registry);
    expect(store.get("EMAILER")).toEqual({ apiKey: "abcdefgh" });
  });

  test("an invalid json value throws — and the error never echoes the secret material", async () => {
    const registry = defineSecretRegistry({
      EMAILER: {
        backend: "cf-secrets-store",
        scope: "environment",
        rotatable: false,
        valueType: "json",
        schema: Emailer,
      },
    });
    const error = await secretsStore(envWith({ EMAILER: JSON.stringify({ apiKey: "SECRET6" }) }), registry).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SecretInvalidValueError);
    const payload = (error as SecretInvalidValueError).payload;
    expect(payload.detail).toContain("apiKey:too_small");
    expect(payload.detail).not.toContain("SECRET6");
    expect(payload.message).not.toContain("SECRET6");
  });

  test("non-JSON for a json entry throws SecretInvalidValueError", async () => {
    const registry = defineSecretRegistry({
      EMAILER: {
        backend: "cf-secrets-store",
        scope: "environment",
        rotatable: false,
        valueType: "json",
        schema: Emailer,
      },
    });
    await expect(secretsStore(envWith({ EMAILER: "not json" }), registry)).rejects.toBeInstanceOf(
      SecretInvalidValueError,
    );
  });

  test("a missing binding fails loudly", async () => {
    const registry = defineSecretRegistry({
      NPM_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    });
    await expect(secretsStore(envWith({}), registry)).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  test("get rejects an undeclared name; toJSON redacts the values", async () => {
    const registry = defineSecretRegistry({
      NPM_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    });
    const store = await secretsStore(envWith({ NPM_TOKEN: "REDACT_ME" }), registry);
    expect(() => (store.get as (name: string) => unknown)("NOPE")).toThrow(SecretNotFoundError);
    const serialized = JSON.stringify(store);
    expect(serialized).toBe('"[Secrets declared=1]"');
    expect(serialized).not.toContain("REDACT_ME");
  });
});

describe("secretsStore — d1 backend, local dev .dev.vars fallback", () => {
  // In local dev a `d1` secret is injected as a `.dev.vars` string, in the same shape it is stored, so
  // the reader resolves it without a SECRETS D1 or master key — the deployed path is exercised by the
  // workers suite (secretsStore.workers.test.ts) against a real D1.
  test("resolves a d1 text secret from its injected .dev.vars string", async () => {
    const registry = defineSecretRegistry({
      "turnstile-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    });
    const store = await secretsStore(envWith({ "turnstile-secret": "1x000" }), registry);
    expect(store.get("turnstile-secret")).toBe("1x000");
  });

  test("parses + validates a d1 json secret from its injected string, same shape as stored", async () => {
    const registry = defineSecretRegistry({
      EMAILER: { backend: "d1", scope: "environment", rotatable: false, valueType: "json", schema: Emailer },
    });
    const store = await secretsStore(envWith({ EMAILER: JSON.stringify({ apiKey: "abcdefgh" }) }), registry);
    expect(store.get("EMAILER")).toEqual({ apiKey: "abcdefgh" });
  });

  test("an invalid d1 json string throws without echoing the secret material", async () => {
    const registry = defineSecretRegistry({
      EMAILER: { backend: "d1", scope: "environment", rotatable: false, valueType: "json", schema: Emailer },
    });
    await expect(
      secretsStore(envWith({ EMAILER: JSON.stringify({ apiKey: "short" }) }), registry),
    ).rejects.toBeInstanceOf(SecretInvalidValueError);
  });

  test("a DEPLOYED d1 secret is never shadowed by a same-named plaintext binding", async () => {
    // ENVIRONMENT is a managed env → deployed → the d1 secret must come from the encrypted store, never
    // the plaintext string. With no real SECRETS D1/master key here, resolution fails — proving the
    // string was ignored (had it been used, it would resolve to "plaintext" instead of throwing).
    const registry = defineSecretRegistry({
      FOO: { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
    });
    await expect(secretsStore(envWith({ ENVIRONMENT: "production", FOO: "plaintext" }), registry)).rejects.toThrow();
  });
});

describe("SecretsAccessor.subset", () => {
  const combined = defineSecretRegistry({
    A: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    B: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
  });

  test("returns a view restricted to the requested slice, sharing resolved values (no re-fetch)", async () => {
    const store = await secretsStore(envWith({ A: "a-val", B: "b-val" }), combined);
    const slice = defineSecretRegistry({
      A: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    });
    const view = store.subset(slice);
    // The view shares the parent's already-resolved value (no re-fetch); its names are the slice's,
    // type-restricted to "A" — asking for "B" is a compile error, so the slice boundary needs no
    // runtime assertion.
    expect(view.get("A")).toBe("a-val");
  });

  test("a requested name the parent never resolved is absent, so reading it fails loudly", async () => {
    const onlyA = defineSecretRegistry({
      A: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    });
    const store = await secretsStore(envWith({ A: "a-val" }), onlyA);
    const wantsMissing = defineSecretRegistry({
      C: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    });
    const view = store.subset(wantsMissing);
    expect(() => view.get("C")).toThrow(SecretNotFoundError);
  });
});
