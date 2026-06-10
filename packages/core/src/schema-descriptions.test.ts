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

describe("schema descriptions (CLAUDE.md §Zod: schemas are the docs)", () => {
  test("every exported object/enum/union — and every field — carries a .describe()", () => {
    const missing: string[] = [];
    let schemasChecked = 0;
    for (const [file, mod] of Object.entries(modules)) {
      for (const [name, value] of Object.entries(mod)) {
        if (value instanceof z.ZodType) {
          schemasChecked++;
          collectMissing(value, `${file}:${name}`, missing);
        }
      }
    }
    expect(schemasChecked).toBeGreaterThan(0); // the glob actually found schemas
    expect(missing).toEqual([]);
  });
});
