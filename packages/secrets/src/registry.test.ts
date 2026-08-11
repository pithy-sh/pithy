// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineSecretRegistry, SecretBackend, type SecretRegistry, SecretScope, SecretValueType } from "./registry";

/** Build an invalid registry without `any`: route a loose object through the param type. */
function asRegistry(value: unknown): SecretRegistry {
  return value as SecretRegistry;
}

describe("secret registry enums", () => {
  test("expose the documented options", () => {
    expect(SecretBackend.options).toEqual(["d1", "cf-secrets-store"]);
    expect(SecretScope.options).toEqual(["environment", "global"]);
    expect(SecretValueType.options).toEqual(["text", "json"]);
  });
});

describe("defineSecretRegistry", () => {
  test("accepts a valid registry across every backend/scope/value-type and rotatability", () => {
    const registry = defineSecretRegistry({
      "auth-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
      "npm-token": { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
      emailer: {
        backend: "d1",
        scope: "environment",
        rotatable: false,
        valueType: "json",
        schema: z.object({ apiKey: z.string().describe("API key.") }).describe("Emailer credentials."),
      },
    });
    expect(Object.keys(registry)).toEqual(["auth-signing-key", "npm-token", "emailer"]);
  });

  test("rejects an unknown backend with InternalError naming the entry", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({ broken: { backend: "nope", scope: "global", rotatable: false, valueType: "text" } }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects an unknown scope", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({ broken: { backend: "d1", scope: "prod", rotatable: false, valueType: "text" } }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects a non-boolean rotatable", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({ broken: { backend: "d1", scope: "global", rotatable: "yes", valueType: "text" } }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects a json entry with no schema", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({ broken: { backend: "d1", scope: "global", rotatable: false, valueType: "json" } }),
      ),
    ).toThrow(InternalError);
  });

  test("accepts a text entry that declares its dev value may be minted", () => {
    const registry = defineSecretRegistry({
      "auth-session-secret": {
        backend: "d1",
        scope: "environment",
        rotatable: true,
        valueType: "text",
        devValue: "random",
      },
    });
    expect(registry["auth-session-secret"].devValue).toBe("random");
  });

  test("leaves devValue off by default — a secret is not generatable until its owner says so", () => {
    const registry = defineSecretRegistry({
      "stripe-key": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
    });
    expect(registry["stripe-key"]).not.toHaveProperty("devValue");
  });

  test("rejects an unknown devValue", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({
          broken: { backend: "d1", scope: "global", rotatable: false, valueType: "text", devValue: "guess" },
        }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects devValue on a json entry — a random string cannot satisfy a schema", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({
          broken: {
            backend: "d1",
            scope: "environment",
            rotatable: false,
            valueType: "json",
            schema: z.object({ clientId: z.string().describe("Client id.") }).describe("A credential pair."),
            devValue: "random",
          },
        }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects devValue on a keyed entry — a keyspace has no one value to mint", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({
          broken: {
            backend: "d1",
            scope: "environment",
            rotatable: false,
            valueType: "text",
            keyed: true,
            devValue: "random",
          },
        }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects an empty name", () => {
    expect(() =>
      defineSecretRegistry(asRegistry({ "": { backend: "d1", scope: "global", rotatable: false, valueType: "text" } })),
    ).toThrow(InternalError);
  });

  test("rejects a name carrying the keyspace separator — it would collide with a member", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({ "KEYSPACE/member": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" } }),
      ),
    ).toThrow(InternalError);
  });
});

describe("defineSecretRegistry — keyed entries", () => {
  test("accepts a keyed entry: a keyspace, not a name", () => {
    const registry = defineSecretRegistry({
      CONNECTION_SIGNING_KEY: {
        backend: "d1",
        scope: "environment",
        rotatable: true,
        valueType: "json",
        schema: z.object({ privateKey: z.string().describe("PKCS#8 key.") }).describe("A connection signing key."),
        keyed: true,
      },
    });
    expect(registry.CONNECTION_SIGNING_KEY.keyed).toBe(true);
  });

  test("rejects a non-boolean keyed", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({
          broken: { backend: "d1", scope: "environment", rotatable: false, valueType: "text", keyed: "yes" },
        }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects a keyed cf-secrets-store entry — a binding cannot exist for a name that does not", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({
          broken: {
            backend: "cf-secrets-store",
            scope: "environment",
            rotatable: false,
            valueType: "text",
            keyed: true,
          },
        }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects a global keyed entry — a member is written to one environment's store", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({ broken: { backend: "d1", scope: "global", rotatable: false, valueType: "text", keyed: true } }),
      ),
    ).toThrow(InternalError);
  });

  test("accepts a bootstrap entry — the one secret read straight from its binding", () => {
    const registry = defineSecretRegistry({
      SECRETS_ENCRYPTION_KEYS: {
        backend: "cf-secrets-store",
        scope: "environment",
        rotatable: false,
        valueType: "text",
        bootstrap: true,
      },
    });
    expect(registry.SECRETS_ENCRYPTION_KEYS.bootstrap).toBe(true);
  });

  test("rejects a d1-backed bootstrap entry — it is read before any store is open", () => {
    // The whole meaning of the axis: a row in the secrets D1 cannot be read until the master key that
    // decrypts it has been resolved, so a `bootstrap` secret that lives there is a definition of a
    // value nothing can ever read. Caught where the author is, not at a read that finds nothing.
    expect(() =>
      defineSecretRegistry(
        asRegistry({
          broken: { backend: "d1", scope: "environment", rotatable: false, valueType: "text", bootstrap: true },
        }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects a keyed bootstrap entry — a keyspace has no one value to bind", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({
          broken: {
            backend: "cf-secrets-store",
            scope: "environment",
            rotatable: false,
            valueType: "text",
            keyed: true,
            bootstrap: true,
          },
        }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects a non-boolean bootstrap", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({
          broken: {
            backend: "cf-secrets-store",
            scope: "environment",
            rotatable: false,
            valueType: "text",
            bootstrap: "yes",
          },
        }),
      ),
    ).toThrow(InternalError);
  });
});

describe("rotateEveryDays — the declared freshness expectation", () => {
  test("is optional, and survives onto the entry", () => {
    const registry = defineSecretRegistry({
      "stripe-live-key": { backend: "d1", scope: "global", rotatable: false, valueType: "text", rotateEveryDays: 90 },
      "no-opinion": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    });
    expect(registry["stripe-live-key"].rotateEveryDays).toBe(90);
    // `in`, not an undefined read: the `const` type param keeps the literal shapes, so an entry that
    // never declared a cadence has no such property to read at all.
    expect("rotateEveryDays" in registry["no-opinion"]).toBe(false);
  });

  test("is allowed on a rotatable: false secret — that is the case it exists for", () => {
    // A third-party key no automation will ever rotate is precisely the one whose drift nothing else
    // surfaces. Refusing the declaration here would silence the secrets that most need saying.
    expect(() =>
      defineSecretRegistry({
        "stripe-live-key": { backend: "d1", scope: "global", rotatable: false, valueType: "text", rotateEveryDays: 30 },
      }),
    ).not.toThrow();
  });

  test("rejects zero, a negative, and a fraction", () => {
    // Each of these makes every future status read permanently overdue — a warning nobody can clear,
    // and therefore one everybody learns to ignore.
    for (const rotateEveryDays of [0, -1, 0.5]) {
      expect(() =>
        defineSecretRegistry(
          asRegistry({
            broken: { backend: "d1", scope: "environment", rotatable: true, valueType: "text", rotateEveryDays },
          }),
        ),
      ).toThrow(InternalError);
    }
  });

  test("rejects a non-number", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({
          broken: { backend: "d1", scope: "environment", rotatable: true, valueType: "text", rotateEveryDays: "90" },
        }),
      ),
    ).toThrow(InternalError);
  });
});
