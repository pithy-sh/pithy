// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { DRY_RUN_ARG, emptyPlan, Plan, planText } from "./plan";

/**
 * **One plan shape, whichever command made it (#697).** Every `--dry-run --json` payload carries `plan`,
 * and an agent reads all of them with one parser. These hold the shape itself; `dryRun.test.ts` holds every
 * command that takes `--dry-run` to it.
 */

describe("Plan", () => {
  test("an empty plan has every list, so one parser reads every command's", () => {
    expect(emptyPlan()).toEqual({ files: [], resources: [], migrations: [], secrets: [], data: [], notes: [] });
    expect(Plan.parse(emptyPlan())).toEqual(emptyPlan());
  });

  test("a plan missing a list is refused, not read as an empty one", () => {
    const { notes: _, ...short } = emptyPlan();
    expect(Plan.safeParse(short).success).toBe(false);
  });

  test("a key no plan names is dropped, so the published shape is the whole shape", () => {
    expect(Plan.parse({ ...emptyPlan(), extra: 1 })).toEqual(emptyPlan());
  });

  test("a move names where it starts", () => {
    const plan = {
      ...emptyPlan(),
      files: [{ path: "apps/board", action: "move", from: "apps/api", changes: [] }],
    };
    expect(Plan.parse(plan)).toEqual(plan);
  });

  test("every field is described, because the descriptions are what pithy schema says", () => {
    const undescribed: string[] = [];
    const visit = (schema: unknown, at: string): void => {
      const json = schema as Record<string, unknown>;
      if (typeof json !== "object" || json === null) return;
      if (json.type !== undefined && typeof json.description !== "string") undescribed.push(at);
      for (const [key, property] of Object.entries((json.properties as Record<string, unknown>) ?? {}))
        visit(property, `${at}.${key}`);
      if (json.items !== undefined) visit(json.items, `${at}[]`);
    };
    visit(z.toJSONSchema(Plan), "$");
    expect(undescribed).toEqual([]);
  });
});

describe("planText", () => {
  test("says each change in the future tense, in the plan's order", () => {
    const lines = planText({
      ...emptyPlan(),
      files: [
        { path: "apps/api", action: "move", from: "apps/board", changes: [] },
        { path: "apps/api/wrangler.jsonc", action: "edit", changes: ["Renames the script."] },
        { path: "apps/api/src/new.ts", action: "create", changes: [] },
      ],
      secrets: [{ name: "SESSION_SECRET", env: "dev", action: "mint", where: "/home/u/.config/pithy/dev.json" }],
      data: [{ store: "d1", target: "DB.users", count: 3, action: "write" }],
      notes: ["Then migrates dev."],
    });
    expect(lines).toEqual([
      "Would move apps/board to apps/api.",
      "Would edit apps/api/wrangler.jsonc.",
      "  Renames the script.",
      "Would create apps/api/src/new.ts.",
      "Would mint SESSION_SECRET (dev) in /home/u/.config/pithy/dev.json.",
      "Would write 3 to d1 DB.users.",
      "Then migrates dev.",
    ]);
  });

  test("a plan with nothing in it says so", () => {
    expect(planText(emptyPlan())).toEqual(["Nothing to change."]);
  });

  test("resources and migrations read the same way", () => {
    expect(
      planText({
        ...emptyPlan(),
        resources: [
          { kind: "d1", name: "acme-staging-db", binding: "DB", env: "staging", action: "create" },
          { kind: "kv", name: "acme-staging-cache", action: "adopt", id: "abc" },
        ],
        migrations: [
          { env: "staging", worker: "api", database: "app", binding: "DB", name: "0001_init", direction: "up" },
          { env: "staging", worker: "api", database: "app", binding: "DB", name: "0002_x", direction: "down" },
        ],
      }),
    ).toEqual([
      "Would create d1 acme-staging-db (DB, staging).",
      "Would adopt kv acme-staging-cache.",
      "Would apply 0001_init to app (DB, staging).",
      "Would roll back 0002_x on app (DB, staging).",
    ]);
  });
});

test("--dry-run is one flag with one description on every command", () => {
  expect(DRY_RUN_ARG).toEqual({ type: "boolean", default: false, description: expect.any(String) });
});
