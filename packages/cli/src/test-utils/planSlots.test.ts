// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { Plan, PlanKey } from "../plan/plan";
import { planSlots } from "./planSlots";

describe("planSlots", () => {
  test("finds the plan under every branch of a union, optional or not", () => {
    const payload = z.union([
      z.object({ command: z.literal("a"), plan: PlanKey }),
      z.object({ command: z.literal("b"), plan: Plan }),
      z.object({ command: z.literal("c") }),
    ]);
    expect(planSlots(payload)).toEqual([Plan, Plan]);
  });

  test("a plan-shaped copy is not the plan: one shape means one schema value", () => {
    const copy = Plan.extend({});
    expect(planSlots(z.object({ plan: copy }))).toEqual([copy]);
    expect(planSlots(z.object({ plan: copy }))[0]).not.toBe(Plan);
  });

  test("a payload with no plan has no slots", () => {
    expect(planSlots(z.object({ command: z.literal("x") }))).toEqual([]);
  });
});
