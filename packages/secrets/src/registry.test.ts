import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  defineSecretRegistry,
  SecretBackend,
  SecretKind,
  type SecretRegistry,
  SecretScope,
  SecretValueType,
} from "./registry";

/** Build an invalid registry without `any`: route a loose object through the param type. */
function asRegistry(value: unknown): SecretRegistry {
  return value as SecretRegistry;
}

describe("secret registry enums", () => {
  test("expose the documented options", () => {
    expect(SecretBackend.options).toEqual(["d1", "cf-secrets-store"]);
    expect(SecretScope.options).toEqual(["environment", "global"]);
    expect(SecretKind.options).toEqual(["simple", "rotatable"]);
    expect(SecretValueType.options).toEqual(["text", "json"]);
  });
});

describe("defineSecretRegistry", () => {
  test("accepts a valid registry across every backend/scope/kind/value-type", () => {
    const registry = defineSecretRegistry({
      "auth-signing-key": { backend: "d1", scope: "environment", kind: "rotatable", valueType: "text" },
      "npm-token": { backend: "cf-secrets-store", scope: "global", kind: "simple", valueType: "text" },
      emailer: {
        backend: "d1",
        scope: "environment",
        kind: "simple",
        valueType: "json",
        schema: z.object({ apiKey: z.string().describe("API key.") }).describe("Emailer credentials."),
      },
    });
    expect(Object.keys(registry)).toEqual(["auth-signing-key", "npm-token", "emailer"]);
  });

  test("rejects an unknown backend with InternalError naming the entry", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({ broken: { backend: "nope", scope: "global", kind: "simple", valueType: "text" } }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects an unknown scope", () => {
    expect(() =>
      defineSecretRegistry(asRegistry({ broken: { backend: "d1", scope: "prod", kind: "simple", valueType: "text" } })),
    ).toThrow(InternalError);
  });

  test("rejects a json entry with no schema", () => {
    expect(() =>
      defineSecretRegistry(
        asRegistry({ broken: { backend: "d1", scope: "global", kind: "simple", valueType: "json" } }),
      ),
    ).toThrow(InternalError);
  });

  test("rejects an empty name", () => {
    expect(() =>
      defineSecretRegistry(asRegistry({ "": { backend: "d1", scope: "global", kind: "simple", valueType: "text" } })),
    ).toThrow(InternalError);
  });
});
