// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { MAX_ADDRESS_LENGTH, normalizeAddress, parseAddress } from "./address";

describe("normalizeAddress", () => {
  test("trims and lowercases, so case is never what tells two people apart", () => {
    expect(normalizeAddress("  Ada@Example.COM  ")).toBe("ada@example.com");
    expect(normalizeAddress("ADA@example.com")).toBe(normalizeAddress("ada@EXAMPLE.com"));
  });

  test("lowercases the local part too, which RFC 5321 does not require", () => {
    // Deliberate, and stated in the module. No provider treats the local part as case-sensitive, and
    // treating `Ada@` and `ada@` as two people splits one customer's history in half.
    expect(normalizeAddress("Ada@example.com")).toBe("ada@example.com");
  });

  test("keeps subaddressing and dots, which are two different people on a self-hosted domain", () => {
    expect(normalizeAddress("Ada+Shop@Example.com")).toBe("ada+shop@example.com");
    expect(normalizeAddress("ada+shop@example.com")).not.toBe(normalizeAddress("ada@example.com"));
    expect(normalizeAddress("Ada.Lovelace@example.com")).toBe("ada.lovelace@example.com");
    expect(normalizeAddress("ada.lovelace@example.com")).not.toBe(normalizeAddress("adalovelace@example.com"));
  });

  test("does not unicode-normalize, so a confusable stays a different address", () => {
    // NFKC would fold U+FF41 FULLWIDTH LATIN SMALL LETTER A onto `a` and hand one person's address to
    // whoever registered the lookalike. The boundary that accepts an address decides whether to allow
    // non-ASCII at all; this function does not silently merge two spellings on its own initiative.
    expect(normalizeAddress("\uff41da@example.com")).not.toBe("ada@example.com");
    // Nor does it fold a decomposed character onto its composed form (NFC). Written as escapes because
    // the two spellings are indistinguishable in an editor, which is exactly the problem.
    expect(normalizeAddress("ad\u00e1@example.com")).not.toBe(normalizeAddress("ada\u0301@example.com"));
  });

  test("is total — every string has a normal form, including the ones that are not addresses", () => {
    // Not a validator. A caller that wants rejection wants `parseAddress`, or Zod at its boundary.
    expect(normalizeAddress("")).toBe("");
    expect(normalizeAddress("Not An Address")).toBe("not an address");
  });

  test("is idempotent", () => {
    const once = normalizeAddress("  Ada+Shop@Example.com ");
    expect(normalizeAddress(once)).toBe(once);
  });
});

describe("parseAddress", () => {
  test("takes the address out of a display-name header", () => {
    expect(parseAddress("Ada Lovelace <ada@example.com>")).toBe("ada@example.com");
  });

  test("prefers the angle-bracketed address when the display name is itself an address", () => {
    expect(parseAddress("ada@personal.example <ada@work.example>")).toBe("ada@work.example");
  });

  test("trims around the whole header", () => {
    expect(parseAddress("  Ada Lovelace <ada@example.com>  ")).toBe("ada@example.com");
  });

  test("normalizes what it accepts, so a parse and a comparison agree", () => {
    expect(parseAddress("Ada Lovelace <Ada+Shop@Example.com>")).toBe("ada+shop@example.com");
    expect(parseAddress("ada@EXAMPLE.COM")).toBe("ada@example.com");
  });

  test("refuses a domain with no dot", () => {
    expect(parseAddress("ada@localhost")).toBeUndefined();
    expect(parseAddress("Ada Lovelace <ada@localhost>")).toBeUndefined();
  });

  test("refuses anything containing whitespace after unwrapping", () => {
    expect(parseAddress("ada lovelace@example.com")).toBeUndefined();
    expect(parseAddress("ada@exa mple.com")).toBeUndefined();
    expect(parseAddress("ada@example.com\tbob@example.com")).toBeUndefined();
  });

  test("refuses a list, which is not one address", () => {
    expect(parseAddress("ada@example.com,bob@example.com")).toBeUndefined();
    expect(parseAddress("ada@example.com;bob@example.com")).toBeUndefined();
  });

  test("refuses stray brackets and quoted local parts", () => {
    expect(parseAddress("<ada@example.com")).toBeUndefined();
    expect(parseAddress("ada@example.com>")).toBeUndefined();
    expect(parseAddress('"ada"@example.com')).toBeUndefined();
  });

  test("refuses a string with no local part or no domain", () => {
    expect(parseAddress("@example.com")).toBeUndefined();
    expect(parseAddress("ada@")).toBeUndefined();
    expect(parseAddress("ada.example.com")).toBeUndefined();
  });

  test("refuses anything past the RFC 5321 path limit", () => {
    const atLimit = `${"a".repeat(MAX_ADDRESS_LENGTH - "@example.com".length)}@example.com`;
    expect(atLimit).toHaveLength(MAX_ADDRESS_LENGTH);
    expect(parseAddress(atLimit)).toBe(atLimit);
    expect(parseAddress(`a${atLimit}`)).toBeUndefined();
  });

  test("padding does not smuggle an over-long address through", () => {
    const padded = `${" ".repeat(10)}${"a".repeat(MAX_ADDRESS_LENGTH)}@example.com`;
    expect(parseAddress(padded)).toBeUndefined();
  });

  test("returns undefined for absent and empty input rather than throwing", () => {
    expect(parseAddress(undefined)).toBeUndefined();
    expect(parseAddress(null)).toBeUndefined();
    expect(parseAddress("")).toBeUndefined();
    expect(parseAddress("   ")).toBeUndefined();
    expect(parseAddress("<>")).toBeUndefined();
  });

  test("is idempotent on its own output", () => {
    const once = parseAddress("Ada Lovelace <Ada+Shop@Example.com>");
    expect(once).toBe("ada+shop@example.com");
    expect(parseAddress(once)).toBe(once);
  });
});
