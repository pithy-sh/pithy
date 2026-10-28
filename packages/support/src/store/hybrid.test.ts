// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { fuse, RRF_K, rollUp } from "./hybrid";

describe("rollUp", () => {
  test("a thread takes the rank of its best message and appears once", () => {
    const ranked = rollUp([
      { messageId: "a1", threadId: "a", score: -3 },
      { messageId: "b1", threadId: "b", score: -2 },
      { messageId: "a2", threadId: "a", score: -1 },
      { messageId: "c1", threadId: "c" },
    ]);
    expect(ranked).toEqual([
      { threadId: "a", messageId: "a1", rank: 1 },
      { threadId: "b", messageId: "b1", rank: 2 },
      { threadId: "c", messageId: "c1", rank: 3 },
    ]);
  });

  test("nothing in, nothing out", () => {
    expect(rollUp([])).toEqual([]);
  });
});

describe("fuse", () => {
  test("sums 1 / (60 + rank) across lists, so a thread both found rises above one only one found", () => {
    const fused = fuse([
      [
        { threadId: "both", messageId: "k-both", rank: 2 },
        { threadId: "keyword", messageId: "k-only", rank: 1 },
      ],
      [
        { threadId: "semantic", messageId: "s-only", rank: 1 },
        { threadId: "both", messageId: "s-both", rank: 2 },
      ],
    ]);
    const score = Object.fromEntries(fused.map((entry) => [entry.threadId, entry.fused]));
    expect(score.both).toBeCloseTo(2 / (RRF_K + 2));
    expect(score.keyword).toBeCloseTo(1 / (RRF_K + 1));
    expect(score.both).toBeGreaterThan(score.keyword as number);
    expect(score.keyword).toBe(score.semantic);
  });

  test("names the message from the list that ranked the thread higher, the first list on a tie", () => {
    const fused = fuse([
      [
        { threadId: "t", messageId: "keyword-message", rank: 3 },
        { threadId: "u", messageId: "u-keyword", rank: 1 },
      ],
      [
        { threadId: "t", messageId: "semantic-message", rank: 1 },
        { threadId: "u", messageId: "u-semantic", rank: 1 },
      ],
    ]);
    expect(fused.find((entry) => entry.threadId === "t")?.messageId).toBe("semantic-message");
    expect(fused.find((entry) => entry.threadId === "u")?.messageId).toBe("u-keyword");
  });

  test("one list fuses to its own order", () => {
    const fused = fuse([
      rollUp([
        { messageId: "1", threadId: "x" },
        { messageId: "2", threadId: "y" },
      ]),
    ]);
    expect(fused.sort((a, b) => b.fused - a.fused).map((entry) => entry.threadId)).toEqual(["x", "y"]);
  });
});
