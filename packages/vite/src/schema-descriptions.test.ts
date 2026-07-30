// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";

// `import.meta.glob` is a vite/vitest feature; declare it so plain `tsc` typecheck accepts it.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

// Eagerly import every source module except tests, so any newly exported schema is covered
// automatically — there is no manual list to keep in sync.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], { eager: true });

/**
 * Record any object/enum/union missing a `.describe()` — on the schema itself or on any of
 * its fields — recursing into nested object fields. Codec-helper primitives are exempt
 * (CLAUDE.md §Zod) and aren't objects/enums/unions, so they're skipped.
 */
function collectMissing(schema: z.ZodType, path: string, missing: string[]): void {
  if (schema instanceof z.ZodObject) {
    if (!schema.description) missing.push(`${path} — object has no .describe()`);
    for (const [key, field] of Object.entries(schema.shape)) {
      const fieldSchema = field as z.ZodType;
      if (!fieldSchema.description) missing.push(`${path}.${key} — field has no .describe()`);
      collectMissing(fieldSchema, `${path}.${key}`, missing);
    }
  } else if (schema instanceof z.ZodUnion || schema instanceof z.ZodEnum) {
    if (!schema.description) missing.push(`${path} — enum/union has no .describe()`);
  }
}

/** Every exported Zod schema in this package, as `file:name`. */
function exportedSchemas(): string[] {
  const found: string[] = [];
  for (const [file, mod] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(mod)) {
      if (value instanceof z.ZodType) found.push(`${file}:${name}`);
    }
  }
  return found;
}

describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("the glob sees this package's modules — a broken pattern must not pass vacuously", () => {
    expect(Object.keys(modules).length).toBeGreaterThan(0);
  });

  /**
   * This package exports no schema: it validates through `@pithy-sh/core`'s `ClientProjection` rather
   * than declaring shapes of its own. So rather than a describe-check that policices nothing, this
   * asserts the *reason* it polices nothing — and fails the moment that stops being true, pointing at
   * what to do. A weakened assertion (`schemasChecked >= 0`) would read as coverage while asserting
   * nothing at all.
   */
  test("exports no Zod schema — when one lands, copy core's describe-check here", () => {
    expect(exportedSchemas()).toEqual([]);
  });

  test("no exported schema is missing a .describe() (vacuous today, correct when it is not)", () => {
    const missing: string[] = [];
    for (const [file, mod] of Object.entries(modules)) {
      for (const [name, value] of Object.entries(mod)) {
        if (value instanceof z.ZodType) collectMissing(value, `${file}:${name}`, missing);
      }
    }
    expect(missing).toEqual([]);
  });
});
