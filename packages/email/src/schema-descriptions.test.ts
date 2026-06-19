import { describe, expect, test } from "vitest";
import { z } from "zod";

// `import.meta.glob` is a vite/vitest feature; declare it so plain `tsc` typecheck accepts it.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

// Eagerly import every source module except tests, so any newly exported schema is covered
// automatically — no manual list to keep in sync. Mirrors core's meta-test. `workflows/worker.ts`
// imports `cloudflare:workers` (Workers-runtime only), so it can't be eagerly imported here — exclude
// it; it exports no schemas anyway.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./workflows/worker.ts"], { eager: true });

/**
 * Record any object/enum/union missing a `.describe()` — on the schema itself or on any of its
 * fields — recursing into nested object fields. Codec-helper primitives are exempt (CLAUDE.md §Zod)
 * and aren't objects/enums/unions, so they're skipped.
 */
/**
 * A description counts if it sits anywhere in the wrapper chain — on the schema itself or on an inner
 * type it wraps. Zod's `.partial()` / `.optional()` move a field's `.describe()` under an optional
 * wrapper, so a derived schema like `EmailTheme.partial()` keeps each field's description on the inner
 * type; unwrapping finds it. Without this, a perfectly-described derived schema would be flagged.
 */
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
