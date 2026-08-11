// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { normalizeDisplayName } from "./address";

/** The bidi embeddings and overrides the cleaner has to remove, U+202A–U+202E. */
const BIDI_OVERRIDES = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e];

/** The bidi isolates, U+2066–U+2069 — the newer spelling of the same trick. */
const BIDI_ISOLATES = [0x2066, 0x2067, 0x2068, 0x2069];

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
