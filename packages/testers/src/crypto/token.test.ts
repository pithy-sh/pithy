// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { generateOptInToken, isOptInTokenShape, OPT_IN_TOKEN_PATTERN } from "./token";

describe("generating a confirmation token", () => {
  test("is URL-safe, so it survives a path segment and an email client untouched", () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const token = generateOptInToken();
      expect(token).toMatch(OPT_IN_TOKEN_PATTERN);
      expect(encodeURIComponent(token)).toBe(token);
    }
  });

  test("carries 256 bits, because the token is the whole credential", () => {
    // Nothing else stands between a link and anyone guessing one, so the entropy is the gate. 32 bytes
    // base64url-encoded and unpadded is 43 characters.
    expect(generateOptInToken()).toHaveLength(43);
  });

  test("never repeats across a large sample", () => {
    const seen = new Set(Array.from({ length: 5000 }, () => generateOptInToken()));
    expect(seen.size).toBe(5000);
  });
});

describe("the shape check", () => {
  test("accepts a real token", () => {
    expect(isOptInTokenShape(generateOptInToken())).toBe(true);
  });

  test("refuses anything that is not one, before it can reach a query", () => {
    // The shape check exists so a malformed segment is rejected without a database round trip. It is
    // not authentication: a well-formed token matching no row still fails, with the same words.
    for (const bad of [
      "",
      "short",
      "a".repeat(42),
      "a".repeat(44),
      `${"a".repeat(42)}=`,
      `${"a".repeat(42)}+`,
      `${"a".repeat(42)}/`,
      "../../../etc/passwd",
      "a".repeat(43).replace("a", "!"),
    ]) {
      expect(isOptInTokenShape(bad), bad).toBe(false);
    }
  });

  test("a well-formed token is still only a shape, never a claim of validity", () => {
    // Documented as a test because the distinction is the whole reason the route looks the row up.
    expect(isOptInTokenShape("A".repeat(43))).toBe(true);
  });
});
