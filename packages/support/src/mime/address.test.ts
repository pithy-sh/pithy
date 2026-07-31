// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { normalizeAddress, normalizeDisplayName } from "./address";

/** The bidi embeddings and overrides the cleaner has to remove, U+202A–U+202E. */
const BIDI_OVERRIDES = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e];

/** The bidi isolates, U+2066–U+2069 — the newer spelling of the same trick. */
const BIDI_ISOLATES = [0x2066, 0x2067, 0x2068, 0x2069];

describe("normalizeAddress", () => {
  test("takes what the angle brackets delimit, dropping the display name", () => {
    expect(normalizeAddress("Ada Lovelace <ada@example.com>")).toBe("ada@example.com");
  });

  test("the angle brackets win over an @ in the display name", () => {
    // Without the unwrap, the local part comes back as `ada@personal.example <ada` and the whitespace
    // check then rejects a perfectly good address. This is the case that proves the brackets are read.
    expect(normalizeAddress("ada@personal.example <ada@work.example>")).toBe("ada@work.example");
  });

  test("tolerates space around the brackets, which real headers carry", () => {
    expect(normalizeAddress("  Ada Lovelace <ada@example.com>  ")).toBe("ada@example.com");
  });

  test("lowercases the domain", () => {
    expect(normalizeAddress("ada@EXAMPLE.COM")).toBe("ada@example.com");
  });

  test("lowercases the local part too, though RFC 5321 calls it case-sensitive", () => {
    // Documented and deliberate: every provider does this, and treating `Ada@` and `ada@` as two
    // people splits one customer's history across two threads and two rate-limit buckets.
    expect(normalizeAddress("Ada@Example.com")).toBe("ada@example.com");
    expect(normalizeAddress("ADA@example.com")).toBe(normalizeAddress("ada@EXAMPLE.com"));
  });

  test("keeps subaddressing — folding `ada+shop@` would merge two real mailboxes into one", () => {
    // Gmail collapses `+` tags; most providers do not. Showing one customer as two is recoverable,
    // showing two customers as one is not, so the tag survives and only the case is folded.
    expect(normalizeAddress("Ada+Shop@Example.com")).toBe("ada+shop@example.com");
    expect(normalizeAddress("ada+shop@example.com")).not.toBe(normalizeAddress("ada@example.com"));
  });

  test("keeps dots in the local part, for the same reason", () => {
    expect(normalizeAddress("Ada.Lovelace@example.com")).toBe("ada.lovelace@example.com");
    expect(normalizeAddress("ada.lovelace@example.com")).not.toBe(normalizeAddress("adalovelace@example.com"));
  });

  test("rejects a domain with no dot — localhost or a typo, never a customer", () => {
    expect(normalizeAddress("ada@localhost")).toBeUndefined();
    expect(normalizeAddress("Ada Lovelace <ada@localhost>")).toBeUndefined();
  });

  test("rejects embedded whitespace, which means this was never one address", () => {
    expect(normalizeAddress("ada lovelace@example.com")).toBeUndefined();
    expect(normalizeAddress("ada@exa mple.com")).toBeUndefined();
    expect(normalizeAddress("ada@example.com\tbob@example.com")).toBeUndefined();
  });

  test("rejects an address list, whether comma- or semicolon-separated", () => {
    // A `To:` with two recipients must not normalize down to something that looks like one mailbox.
    expect(normalizeAddress("ada@example.com,bob@example.com")).toBeUndefined();
    expect(normalizeAddress("ada@example.com;bob@example.com")).toBeUndefined();
  });

  test("rejects stray angle brackets and quotes left over after unwrapping", () => {
    expect(normalizeAddress("<ada@example.com")).toBeUndefined();
    expect(normalizeAddress("ada@example.com>")).toBeUndefined();
    expect(normalizeAddress('"ada"@example.com')).toBeUndefined();
  });

  test("rejects anything missing a local part or a domain", () => {
    expect(normalizeAddress("@example.com")).toBeUndefined();
    expect(normalizeAddress("ada@")).toBeUndefined();
    expect(normalizeAddress("ada.example.com")).toBeUndefined();
  });

  test("accepts an address at the 256-octet path limit and refuses one past it", () => {
    // RFC 5321 caps a path at 256 octets. An off-by-one here silently drops or admits real mail.
    const atLimit = `${"a".repeat(244)}@example.com`;
    expect(atLimit).toHaveLength(256);
    expect(normalizeAddress(atLimit)).toBe(atLimit);
    expect(normalizeAddress(`a${atLimit}`)).toBeUndefined();
  });

  test("measures the bound before the brackets come off, so a long display name counts against it", () => {
    const padded = `${"A".repeat(250)} <ada@example.com>`;
    expect(normalizeAddress(padded)).toBeUndefined();
  });

  test("returns undefined for missing, empty, and whitespace-only input rather than throwing", () => {
    // Inbound mail is attacker-controlled, so a malformed `From` is an expected input. A throw here
    // would take down the parse instead of letting the caller choose to drop or store the message.
    expect(normalizeAddress(undefined)).toBeUndefined();
    expect(normalizeAddress(null)).toBeUndefined();
    expect(normalizeAddress("")).toBeUndefined();
    expect(normalizeAddress("   ")).toBeUndefined();
    expect(normalizeAddress("<>")).toBeUndefined();
  });

  test("is idempotent — normalizing a stored address returns the same bytes", () => {
    // Every join keys on this value, so a second pass has to be a no-op or the comparisons drift.
    const once = normalizeAddress("Ada Lovelace <Ada+Shop@Example.com>");
    expect(once).toBe("ada+shop@example.com");
    expect(normalizeAddress(once)).toBe(once);
  });
});

describe("normalizeDisplayName", () => {
  test("keeps an ordinary name intact, trimmed", () => {
    expect(normalizeDisplayName("  Ada Lovelace  ")).toBe("Ada Lovelace");
  });

  test("strips C0 control characters", () => {
    // A CRLF in a display name is a header-injection primitive the moment anything re-emits it.
    expect(normalizeDisplayName("Ada\u0007 Lovelace")).toBe("Ada Lovelace");
    expect(normalizeDisplayName("Ada\r\nBcc: mallory@example.com")).toBe("AdaBcc: mallory@example.com");
  });

  test("strips C1 control characters too", () => {
    expect(normalizeDisplayName("Ada\u007f\u009bLovelace")).toBe("AdaLovelace");
  });

  test("strips the bidi embeddings and overrides, U+202A–U+202E", () => {
    // These are what let `moc.elpmaxe@ada` render as `ada@example.com` in an agent's inbox.
    for (const code of BIDI_OVERRIDES) {
      const label = `U+${code.toString(16).toUpperCase()}`;
      expect(normalizeDisplayName(`Ada${String.fromCodePoint(code)}Lovelace`), label).toBe("AdaLovelace");
    }
  });

  test("strips the bidi isolates, U+2066–U+2069", () => {
    for (const code of BIDI_ISOLATES) {
      const label = `U+${code.toString(16).toUpperCase()}`;
      expect(normalizeDisplayName(`Ada${String.fromCodePoint(code)}Lovelace`), label).toBe("AdaLovelace");
    }
  });

  test("bounds the name at 200 characters", () => {
    expect(normalizeDisplayName("a".repeat(250))).toHaveLength(200);
    expect(normalizeDisplayName("a".repeat(200))).toHaveLength(200);
  });

  test("measures the bound after cleaning, so control padding cannot push real text past it", () => {
    const padded = `${"\u202e".repeat(100)}${"a".repeat(150)}`;
    expect(normalizeDisplayName(padded)).toBe("a".repeat(150));
  });

  test("yields undefined when nothing survives the cleaning", () => {
    expect(normalizeDisplayName(" \u202e\u2066 ")).toBeUndefined();
    expect(normalizeDisplayName("   ")).toBeUndefined();
    expect(normalizeDisplayName("")).toBeUndefined();
  });

  test("returns undefined for missing input rather than throwing", () => {
    expect(normalizeDisplayName(undefined)).toBeUndefined();
    expect(normalizeDisplayName(null)).toBeUndefined();
  });

  test("leaves the name untrusted text — it guarantees text, not safety", () => {
    // No escaping happens here by design; the renderer still owns that. Silently stripping `<` would
    // hide the injection from the layer that has to handle it.
    expect(normalizeDisplayName("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });
});
