// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";

declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

// Eagerly import every source module except tests, so any newly exported schema is covered automatically —
// no manual list to keep in sync. Mirrors core's and leaderboard's meta-test.
//
// Only the Durable Object module and its test-worker shell are excluded: they import `cloudflare:workers`,
// which resolves in the Workers runtime and nowhere else. Their exported schemas are re-exported from the
// pure `config`/`state` modules, which this test does cover.
//
// `capability.ts`, `index.ts`, and `http/routes.ts` used to be excluded here too, for the same reason —
// they reached the DO transitively. #172 cut that edge, and dropping them from this list is what proves
// it: the entry point an adopter's `pithy.config.ts` imports now loads in a node environment.
const modules = import.meta.glob(
  ["./**/*.ts", "!./**/*.test.ts", "!./session/durableObject.ts", "!./session/testWorker.ts"],
  { eager: true },
);

function describedSomewhere(schema: z.ZodType): boolean {
  let current: z.ZodType | undefined = schema;
  while (current) {
    if (current.description) return true;
    current = (current as unknown as { def?: { innerType?: z.ZodType } }).def?.innerType;
  }
  return false;
}

function collectMissing(schema: z.ZodType, path: string, missing: string[]): void {
  if (schema instanceof z.ZodObject) {
    if (!schema.description) missing.push(`${path} — object has no .describe()`);
    for (const [key, field] of Object.entries(schema.shape)) {
      const fieldSchema = field as z.ZodType;
      if (!describedSomewhere(fieldSchema)) missing.push(`${path}.${key} — field has no .describe()`);
      collectMissing(fieldSchema, `${path}.${key}`, missing);
    }
  } else if (schema instanceof z.ZodUnion || schema instanceof z.ZodEnum) {
    if (!schema.description) missing.push(`${path} — enum/union has no .describe()`);
  }
}

describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const missing: string[] = [];
    for (const [file, mod] of Object.entries(modules)) {
      for (const [name, value] of Object.entries(mod)) {
        if (value instanceof z.ZodType) collectMissing(value, `${file}:${name}`, missing);
      }
    }
    expect(missing).toEqual([]);
  });
});
