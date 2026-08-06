// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { KEYSPACE_SEPARATOR, keyedSecretName, parseKeyedSecretName, SecretKey } from "./keyspace";

describe("keyedSecretName", () => {
  test("composes the keyspace and the member key with the one separator", () => {
    expect(keyedSecretName("CONNECTION_SIGNING_KEY", "conn_a1b2")).toBe("CONNECTION_SIGNING_KEY/conn_a1b2");
    expect(KEYSPACE_SEPARATOR).toBe("/");
  });

  test("accepts the identifier shapes a tenant id actually takes", () => {
    for (const key of ["a", "0b6e3c4a-1f2d-4c8b-9e77-1a2b3c4d5e6f", "conn.staging_01", "A-B_c.9"]) {
      expect(keyedSecretName("KEYSPACE", key)).toBe(`KEYSPACE/${key}`);
    }
  });

  test("refuses a key carrying the separator — one tenant must not reach another keyspace", () => {
    expect(() => keyedSecretName("CONNECTION_SIGNING_KEY", "../OTHER_KEYSPACE/victim")).toThrow(ValidationError);
    expect(() => keyedSecretName("CONNECTION_SIGNING_KEY", "a/b")).toThrow(ValidationError);
  });

  test("refuses an empty, blank, or oversized key", () => {
    expect(() => keyedSecretName("K", "")).toThrow(ValidationError);
    expect(() => keyedSecretName("K", " ")).toThrow(ValidationError);
    expect(() => keyedSecretName("K", "a b")).toThrow(ValidationError);
    expect(() => keyedSecretName("K", "a\nb")).toThrow(ValidationError);
    expect(() => keyedSecretName("K", "a".repeat(129))).toThrow(ValidationError);
    expect(keyedSecretName("K", "a".repeat(128))).toBe(`K/${"a".repeat(128)}`);
  });

  test("refuses a key that does not start with a letter or digit", () => {
    expect(() => keyedSecretName("K", ".hidden")).toThrow(ValidationError);
    expect(() => keyedSecretName("K", "-dash")).toThrow(ValidationError);
    expect(() => keyedSecretName("K", "_under")).toThrow(ValidationError);
  });

  test("the refusal names the keyspace and never echoes the key", () => {
    const error = (() => {
      try {
        keyedSecretName("CONNECTION_SIGNING_KEY", "tenant-secret/../escape");
        return undefined;
      } catch (thrown) {
        return thrown as ValidationError;
      }
    })();
    expect(error).toBeInstanceOf(ValidationError);
    expect(error?.payload.detail).toContain("CONNECTION_SIGNING_KEY");
    expect(JSON.stringify(error?.payload)).not.toContain("escape");
  });
});

describe("parseKeyedSecretName", () => {
  test("splits a stored member back into its keyspace and key", () => {
    expect(parseKeyedSecretName("CONNECTION_SIGNING_KEY/conn_a1b2")).toEqual({
      name: "CONNECTION_SIGNING_KEY",
      key: "conn_a1b2",
    });
  });

  test("returns undefined for a plain name, an empty key, or an empty keyspace", () => {
    expect(parseKeyedSecretName("NPM_TOKEN")).toBeUndefined();
    expect(parseKeyedSecretName("NPM_TOKEN/")).toBeUndefined();
    expect(parseKeyedSecretName("/conn_a1b2")).toBeUndefined();
  });

  test("returns undefined when the key part is not a legal key", () => {
    expect(parseKeyedSecretName("KEYSPACE/a/b")).toBeUndefined();
    expect(parseKeyedSecretName("KEYSPACE/ spaced")).toBeUndefined();
  });
});

describe("SecretKey", () => {
  test("is the one schema both composition and parsing validate against", () => {
    expect(SecretKey.safeParse("conn_a1b2").success).toBe(true);
    expect(SecretKey.safeParse("a/b").success).toBe(false);
  });
});
