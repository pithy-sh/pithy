// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { byteLength, truncateToBytes } from "./truncate";

/**
 * Byte-accurate truncation.
 *
 * The cost tests matter as much as the correctness ones here. The first version of this function was
 * correct and quadratic — three minutes of CPU on a large CJK body, inside an `email()` handler the
 * runtime kills long before that, so the message was never stored and every redelivery hit the same
 * wall. A bound that loses the message is worse than no bound, and only a timing assertion catches it.
 */

const CJK = "漢";
const EMOJI = "😀";

describe("truncateToBytes", () => {
  test("leaves anything already within budget untouched", () => {
    expect(truncateToBytes("hello", 1000)).toBe("hello");
  });

  test("counts bytes, not code units — the reason it exists", () => {
    // Three bytes per character, so ten characters do not fit in a nine-byte budget.
    const out = truncateToBytes(CJK.repeat(10), 9);
    expect(out).toBe(CJK.repeat(3));
    expect(byteLength(out)).toBe(9);
  });

  test("never exceeds the budget, across scripts and boundaries", () => {
    for (const source of [CJK.repeat(100), EMOJI.repeat(100), "a".repeat(100), `${CJK}a${EMOJI}`.repeat(50)]) {
      for (const max of [0, 1, 3, 4, 7, 11, 64, 99]) {
        expect(byteLength(truncateToBytes(source, max))).toBeLessThanOrEqual(max);
      }
    }
  });

  test("never returns a lone surrogate", () => {
    // An emoji is a surrogate pair; cutting between its halves would store invalid text.
    for (const max of [1, 2, 3, 5, 6, 7]) {
      const out = truncateToBytes(EMOJI.repeat(4), max);
      expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
      expect(out).toBe(EMOJI.repeat(Math.floor(max / 4)));
    }
  });

  test("a zero or negative budget yields nothing rather than looping", () => {
    expect(truncateToBytes("hello", 0)).toBe("");
    expect(truncateToBytes("hello", -1)).toBe("");
  });

  test("truncating a large multi-byte body is fast — the regression that mattered", () => {
    // 400k CJK characters is 1.2 MB, comfortably inside the 2 MB inbound size bound, so this is an
    // ordinary message rather than an extreme one. The quadratic version took ~178 seconds; anything
    // above a second here means the back-off loop is back.
    const body = CJK.repeat(400_000);
    const started = Date.now();
    const out = truncateToBytes(body, 262_144);
    const elapsed = Date.now() - started;

    expect(byteLength(out)).toBeLessThanOrEqual(262_144);
    expect(elapsed).toBeLessThan(1_000);
  });
});
