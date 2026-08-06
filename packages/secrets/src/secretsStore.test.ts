// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { appendVersion, initialVersionedValue, type VersionedValue } from "./crypto/versionedValue";
import type { SecretsStoreEnv } from "./env/bindings";
import { SecretInvalidValueError, SecretNotFoundError } from "./error/errors";
import { defineSecretRegistry } from "./registry";
import { type KeyedSecretSource, SecretsAccessor, secretsStore } from "./secretsStore";

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
    await expect(secretsStore(envWith({ ENVIRONMENT: "prod", FOO: "plaintext" }), registry)).rejects.toThrow();
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

describe("SecretsAccessor — keyed entries (a per-tenant keyspace)", () => {
  const ConnectionKey = z
    .object({ privateKey: z.string().min(8).describe("PKCS#8 private key.") })
    .describe("A customer connection's signing key.");

  const keyspace = defineSecretRegistry({
    CONNECTION_SIGNING_KEY: {
      backend: "d1",
      scope: "environment",
      rotatable: true,
      valueType: "json",
      schema: ConnectionKey,
      keyed: true,
    },
  });

  const named = defineSecretRegistry({
    NPM_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
  });

  /** Call `getKeyed` with a name the types refuse — the runtime guard is what is under test. */
  function loosely(accessor: object): { getKeyed(name: string, key: string): Promise<unknown> } {
    return accessor as { getKeyed(name: string, key: string): Promise<unknown> };
  }

  /** A source over stored names, so a test asserts exactly which name a read asked for. */
  function sourceOver(stored: Record<string, VersionedValue>) {
    return vi.fn<KeyedSecretSource>(async (name) => stored[name]);
  }

  test("getKeyed resolves one member, composed as <keyspace>/<key>", async () => {
    const source = sourceOver({
      "CONNECTION_SIGNING_KEY/conn_a": initialVersionedValue(JSON.stringify({ privateKey: "alpha-key" })),
    });
    const secrets = new SecretsAccessor(keyspace, {}, source);

    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({ privateKey: "alpha-key" });
    expect(source).toHaveBeenCalledWith("CONNECTION_SIGNING_KEY/conn_a");
  });

  test("one tenant's key never resolves another tenant's member", async () => {
    const source = sourceOver({
      "CONNECTION_SIGNING_KEY/conn_a": initialVersionedValue(JSON.stringify({ privateKey: "alpha-key" })),
      "CONNECTION_SIGNING_KEY/conn_b": initialVersionedValue(JSON.stringify({ privateKey: "bravo-key" })),
    });
    const secrets = new SecretsAccessor(keyspace, {}, source);

    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({ privateKey: "alpha-key" });
    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_b")).toEqual({ privateKey: "bravo-key" });
  });

  test("a key carrying the separator is refused before the store is touched", async () => {
    const source = sourceOver({ "OTHER_KEYSPACE/victim": initialVersionedValue("{}") });
    const secrets = new SecretsAccessor(keyspace, {}, source);

    await expect(secrets.getKeyed("CONNECTION_SIGNING_KEY", "../OTHER_KEYSPACE/victim")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(source).not.toHaveBeenCalled();
  });

  test("an unstored member fails closed, and the refusal never echoes the key", async () => {
    const secrets = new SecretsAccessor(keyspace, {}, sourceOver({}));

    const error = await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretNotFoundError);
    expect(JSON.stringify((error as SecretNotFoundError).payload)).not.toContain("conn_missing");
  });

  test("a member failing its schema throws without echoing the material or the key", async () => {
    const source = sourceOver({
      "CONNECTION_SIGNING_KEY/conn_a": initialVersionedValue(JSON.stringify({ privateKey: "SHORT" })),
    });
    const secrets = new SecretsAccessor(keyspace, {}, source);

    const error = await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretInvalidValueError);
    const serialized = JSON.stringify((error as SecretInvalidValueError).payload);
    expect(serialized).toContain("privateKey:too_small");
    expect(serialized).not.toContain("SHORT");
    expect(serialized).not.toContain("conn_a");
  });

  test("getKeyedVersions exposes the pointer and every still-valid version of one member", async () => {
    const source = sourceOver({
      "CONNECTION_SIGNING_KEY/conn_a": appendVersion(
        initialVersionedValue(JSON.stringify({ privateKey: "old-key-1" })),
        JSON.stringify({ privateKey: "new-key-2" }),
      ),
    });
    const secrets = new SecretsAccessor(keyspace, {}, source);

    expect(await secrets.getKeyedVersions("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({
      currentVersion: "2",
      versions: { "1": { privateKey: "old-key-1" }, "2": { privateKey: "new-key-2" } },
    });
  });

  test("get refuses a keyspace — it has no single value", async () => {
    const secrets = new SecretsAccessor(keyspace, {}, sourceOver({}));
    expect(() => (secrets.get as (name: string) => unknown)("CONNECTION_SIGNING_KEY")).toThrow(InternalError);
  });

  test("getKeyed refuses a named entry — a named secret is not a keyspace", async () => {
    const secrets = new SecretsAccessor(named, {
      NPM_TOKEN: { current: "npm-abc", currentVersion: "1", versions: {} },
    });
    await expect(loosely(secrets).getKeyed("NPM_TOKEN", "conn_a")).rejects.toBeInstanceOf(InternalError);
  });

  test("getKeyed refuses an undeclared keyspace", async () => {
    const secrets = new SecretsAccessor(keyspace, {}, sourceOver({}));
    await expect(loosely(secrets).getKeyed("NOT_DECLARED", "conn_a")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  test("an accessor with no source fails closed rather than resolving nothing", async () => {
    const secrets = new SecretsAccessor(keyspace, {});
    await expect(secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).rejects.toBeInstanceOf(InternalError);
  });

  test("toJSON still redacts after a member has been read", async () => {
    const source = sourceOver({
      "CONNECTION_SIGNING_KEY/conn_a": initialVersionedValue(JSON.stringify({ privateKey: "REDACT_ME_KEY" })),
    });
    const secrets = new SecretsAccessor(keyspace, {}, source);

    await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a");

    const serialized = JSON.stringify(secrets);
    expect(serialized).toBe('"[Secrets declared=1]"');
    expect(serialized).not.toContain("REDACT_ME_KEY");
  });

  test("subset keeps the keyspace readable, and rebinds the source when given one", async () => {
    const stale = sourceOver({
      "CONNECTION_SIGNING_KEY/conn_a": initialVersionedValue(JSON.stringify({ privateKey: "stale-key" })),
    });
    const fresh = sourceOver({
      "CONNECTION_SIGNING_KEY/conn_a": initialVersionedValue(JSON.stringify({ privateKey: "fresh-key" })),
    });
    const secrets = new SecretsAccessor(keyspace, {}, stale);

    expect(await secrets.subset(keyspace).getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({
      privateKey: "stale-key",
    });
    expect(await secrets.subset(keyspace, fresh).getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({
      privateKey: "fresh-key",
    });
  });
});

describe("secretsStore — keyed entries are resolved at read, not up front", () => {
  const keyspace = defineSecretRegistry({
    CONNECTION_SIGNING_KEY: { backend: "d1", scope: "environment", rotatable: true, valueType: "text", keyed: true },
    NPM_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
  });

  test("a keyspace needs no binding and no row in dev — a named entry alongside it still does", async () => {
    const secrets = await secretsStore(envWith({ NPM_TOKEN: "npm-abc" }), keyspace);
    expect(secrets.get("NPM_TOKEN")).toBe("npm-abc");
  });

  test("a keyspace is not fetched from the store when the accessor is built, deployed or not", async () => {
    // No SECRETS D1 and no master key here: building the accessor would throw if a keyspace were
    // batched into the deployed d1 read. Members are fetched one at a time, at the read.
    const onlyKeyspace = defineSecretRegistry({
      CONNECTION_SIGNING_KEY: { backend: "d1", scope: "environment", rotatable: true, valueType: "text", keyed: true },
    });
    await expect(secretsStore(envWith({ ENVIRONMENT: "prod" }), onlyKeyspace)).resolves.toBeInstanceOf(SecretsAccessor);
  });
});
