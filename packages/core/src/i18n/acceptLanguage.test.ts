// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { parseAcceptLanguage } from "./acceptLanguage";

describe("parseAcceptLanguage", () => {
  test("honors the whole q-weighted list, most-wanted first", () => {
    // Reading only the head answers English here, to a reader who asked for Portuguese then Spanish.
    expect(parseAcceptLanguage("pt-PT;q=1.0, es;q=0.8, en;q=0.5")).toEqual([
      { range: "pt-pt", quality: 1 },
      { range: "es", quality: 0.8 },
      { range: "en", quality: 0.5 },
    ]);
  });

  test("an absent weight is 1, and equal weights keep header order", () => {
    expect(parseAcceptLanguage("fr, de, es")).toEqual([
      { range: "fr", quality: 1 },
      { range: "de", quality: 1 },
      { range: "es", quality: 1 },
    ]);
  });

  test("drops the tokens Intl would throw on, and keeps the wildcard", () => {
    expect(parseAcceptLanguage("en_US, , *, es")).toEqual([
      { range: "*", quality: 1 },
      { range: "es", quality: 1 },
    ]);
  });

  test("q=0 is a refusal, not a weak preference", () => {
    expect(parseAcceptLanguage("de;q=0, es;q=0.4")).toEqual([{ range: "es", quality: 0.4 }]);
  });

  test("an unparseable weight falls back to 1 rather than dropping the entry", () => {
    expect(parseAcceptLanguage("es;q=abc")).toEqual([{ range: "es", quality: 1 }]);
  });

  test("an absent, empty or oversized header is an empty list, never a throw", () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
    expect(parseAcceptLanguage(`${"es,".repeat(4000)}en`)).toEqual([]);
  });

  test("a header of ten thousand entries is bounded rather than walked", () => {
    expect(parseAcceptLanguage("es,".repeat(500).slice(0, -1)).length).toBeLessThanOrEqual(32);
  });
});
