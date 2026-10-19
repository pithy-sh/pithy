// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SecretCryptoError } from "../error/errors";
import {
  appendVersion,
  currentValue,
  decodeVersionedValue,
  encodeVersionedValue,
  initialVersionedValue,
  retireVersions,
  rotatedValue,
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

describe("a rotation's versions (#602)", () => {
  test("rotatedValue appends the successor and names every version it now overlaps", () => {
    const rotated = rotatedValue({ currentVersion: "2", versions: { "1": "a", "2": "b" } }, "c");
    expect(rotated).toEqual({
      value: { currentVersion: "3", versions: { "1": "a", "2": "b", "3": "c" } },
      version: "3",
      prior: ["1", "2"],
    });
  });

  test("rotatedValue is idempotent on the value: a store retried with the same successor appends nothing", () => {
    const once = rotatedValue(initialVersionedValue("a"), "b");
    const twice = rotatedValue(once.value, "b");
    expect(twice).toEqual(once);
  });

  test("retireVersions drops the named versions and keeps the current one whatever it is asked", () => {
    const value = { currentVersion: "3", versions: { "1": "a", "2": "b", "3": "c" } };
    expect(retireVersions(value, ["1", "2"])).toEqual({ currentVersion: "3", versions: { "3": "c" } });
    expect(retireVersions(value, ["3"])).toEqual(value);
  });

  test("retireVersions is idempotent: a version already gone is not an error", () => {
    const value = { currentVersion: "3", versions: { "3": "c" } };
    expect(retireVersions(value, ["1"])).toEqual(value);
  });
});
