// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ArgsDef } from "citty";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { contractOf } from "../contract/commandContract";
import { type TreeNode, walkTree } from "../contract/describe";
import { main } from "../main";
import { planSlots } from "../test-utils/planSlots";
import { DRY_RUN_ARG, Plan, PlanKey } from "./plan";

/**
 * **Every `--dry-run --json` payload shares one plan schema (#697).**
 *
 * The property is only true as a set, so this asks it of the whole tree: every command that takes
 * `--dry-run` declares it as {@link DRY_RUN_ARG}, and its published payload carries `dryRun` and a `plan`
 * whose schema is {@link Plan} itself — not a copy that happens to match today. A copy is how two commands
 * drift into two shapes, and the identity check is what makes a copy fail here rather than in an agent.
 *
 * Each command's real `--dry-run --json` output is parsed against that same payload by its own suite
 * (`expectConforms`), so the shape published here is the shape written.
 */

const nodes = await walkTree(main);
const pathOf = (node: TreeNode) => node.path.join(" ");

async function argsOf(node: TreeNode): Promise<ArgsDef> {
  const args = node.cmd.args;
  return ((typeof args === "function" ? await args() : await args) ?? {}) as ArgsDef;
}

const planning: TreeNode[] = [];
for (const node of nodes) {
  if (typeof node.cmd.run === "function" && "dry-run" in (await argsOf(node))) planning.push(node);
}

/** Every branch of a payload that carries `plan`, and whether it also says `dryRun` as a boolean. */
function dryRunKeys(schema: z.ZodType): boolean[] {
  const found: boolean[] = [];
  const visit = (node: z.ZodType): void => {
    if (node instanceof z.ZodUnion || node instanceof z.ZodDiscriminatedUnion) {
      for (const option of node.options as readonly z.ZodType[]) visit(option);
      return;
    }
    if (!(node instanceof z.ZodObject)) return;
    const shape = node.shape as Record<string, z.ZodType | undefined>;
    if (shape.plan === undefined) return;
    found.push(shape.dryRun instanceof z.ZodBoolean || shape.dryRun instanceof z.ZodLiteral);
  };
  visit(schema);
  return found;
}

describe("--dry-run, across the tree", () => {
  test("the commands that plan, by path: all eleven that mutate", () => {
    expect(planning.map(pathOf).sort()).toEqual([
      "add",
      "deploy",
      "feature prune",
      "migrate",
      "payments reconcile",
      "provision",
      "secrets rotate",
      "seed",
      "ui add",
      "upgrade",
      "worker rename",
    ]);
  });

  test.each(planning.map((node) => [pathOf(node), node] as const))(
    "pithy %s declares --dry-run as the one shared flag",
    async (_path, node) => {
      expect((await argsOf(node))["dry-run"]).toEqual(DRY_RUN_ARG);
    },
  );

  test.each(planning.map((node) => [pathOf(node), node] as const))(
    "pithy %s publishes dryRun and the one Plan schema",
    (_path, node) => {
      const payload = contractOf(node.cmd)?.payload;
      expect(payload, "a planning command publishes a payload").toBeDefined();
      const slots = planSlots(payload as z.ZodType);
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) expect(slot).toBe(Plan);
      expect(dryRunKeys(payload as z.ZodType)).not.toContain(false);
    },
  );

  test("a plan-shaped copy is caught: one shape means one schema value", () => {
    const planted = z.object({ dryRun: z.boolean(), plan: Plan.extend({}).optional() });
    expect(planSlots(planted)[0]).not.toBe(Plan);
    expect(planSlots(z.object({ dryRun: z.boolean(), plan: PlanKey }))[0]).toBe(Plan);
  });

  test("a plan without dryRun beside it is caught", () => {
    expect(dryRunKeys(z.object({ plan: PlanKey }))).toEqual([false]);
  });
});
