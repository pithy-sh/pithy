// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { PruneOutcome } from "../retention/prune";
import { mergePruned } from "./worker";

const pruned = (deleted: number): PruneOutcome => ({ state: "pruned", deleted });
const partial = (deleted: number, unpruned: string[]): PruneOutcome => ({
  state: "partial",
  counted: { deleted },
  unpruned,
});

describe("mergePruned", () => {
  test("two complete sweeps stay complete, their deletions summed", () => {
    expect(mergePruned(pruned(3), pruned(4))).toEqual(pruned(7));
  });

  test("two empty sweeps are one complete sweep that deleted nothing", () => {
    expect(mergePruned(pruned(0), pruned(0))).toEqual(pruned(0));
  });

  test("a short sweep on either side makes the whole partial, counting both sides' deletions", () => {
    expect(mergePruned(partial(2, ["b1"]), pruned(5))).toEqual(partial(7, ["b1"]));
    expect(mergePruned(pruned(5), partial(2, ["level/abc"]))).toEqual(partial(7, ["level/abc"]));
  });

  test("two short sweeps carry every unpruned board, in order, and sum what each counted", () => {
    expect(mergePruned(partial(1, ["b1", "b2"]), partial(6, ["level/abc"]))).toEqual(
      partial(7, ["b1", "b2", "level/abc"]),
    );
  });
});
