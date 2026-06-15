import { describe, expect, test } from "vitest";
import { SecretCryptoError } from "../error/errors";
import {
  appendVersion,
  currentValue,
  decodeVersionedValue,
  encodeVersionedValue,
  initialVersionedValue,
} from "./versionedValue";

describe("versioned value serde", () => {
  test("initialVersionedValue points currentVersion at version 1", () => {
    expect(initialVersionedValue("v")).toEqual({ currentVersion: "1", versions: { "1": "v" } });
  });

  test("appendVersion adds the next version and repoints currentVersion", () => {
    const value = appendVersion(initialVersionedValue("a"), "b");
    expect(value).toEqual({ currentVersion: "2", versions: { "1": "a", "2": "b" } });
    expect(currentValue(value)).toBe("b");
  });

  test("currentValue reads the explicit pointer, not a sorted key", () => {
    // currentVersion "2" is current even though "10" is a numerically-higher key present.
    const value = { currentVersion: "2", versions: { "1": "a", "2": "b", "10": "z" } };
    expect(currentValue(value)).toBe("b");
  });

  test("encode/decode round-trips an envelope", () => {
    const value = { currentVersion: "2", versions: { "1": "a", "2": "b" } };
    expect(decodeVersionedValue(encodeVersionedValue(value))).toEqual(value);
  });

  test("decode rejects non-JSON plaintext", () => {
    expect(() => decodeVersionedValue("not json")).toThrow(SecretCryptoError);
  });

  test("decode rejects a shape that is not a versioned value", () => {
    expect(() => decodeVersionedValue(JSON.stringify({ "1": "a" }))).toThrow(SecretCryptoError);
  });

  test("currentValue throws when the pointer is dangling", () => {
    expect(() => currentValue({ currentVersion: "3", versions: { "1": "a" } })).toThrow(SecretCryptoError);
  });
});
