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

// `workflows/worker.ts` is excluded because it imports `cloudflare:workers`, which does not resolve in
// a node context. It exports no schema, so nothing is lost.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./workflows/worker.ts"], { eager: true });

/** Walk `.def.innerType` so `.optional()`, `.nullable()`, and `.default()` wrappers do not hide a description. */
function describedSomewhere(schema: z.ZodType): boolean {
  let current: z.ZodType | undefined = schema;
  while (current) {
    if (current.description) return true;
    current = (current as unknown as { def?: { innerType?: z.ZodType } }).def?.innerType;
  }
  return false;
}

/**
 * Unwrap every wrapper until an object, union or enum is reached.
 *
 * `.optional()`, `.nullable()`, `.array()` and `.default()` all hold their subject one level down, and
 * the walk stopped at each of them — so an inline object behind any wrapper was checked for a
 * description on the wrapper and then abandoned. The same gap was found and fixed in `honesty.test.ts`;
 * this file enforces CLAUDE.md's "every field in every Zod object MUST have a `.describe()`" rule, so
 * it needs the same treatment.
 */
function unwrap(schema: z.ZodType): z.ZodType {
  let current: z.ZodType | undefined = schema;
  const seen = new Set<z.ZodType>();
  while (
    current &&
    !(current instanceof z.ZodObject) &&
    !(current instanceof z.ZodUnion) &&
    !(current instanceof z.ZodEnum)
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    const def: { innerType?: z.ZodType; element?: z.ZodType } | undefined = (
      current as unknown as { def?: { innerType?: z.ZodType; element?: z.ZodType } }
    ).def;
    const next: z.ZodType | undefined = def?.innerType ?? def?.element;
    if (!next) break;
    current = next;
  }
  return current ?? schema;
}

function collectMissing(original: z.ZodType, path: string, missing: string[]): void {
  // Described-ness is asked of the schema as written — a `.describe()` on the `.optional()` wrapper
  // describes the field, and `describedSomewhere` already walks down the chain to find it. The *shape*
  // is asked of the unwrapped schema, so the walk reaches an inline object behind a wrapper instead of
  // stopping at the wrapper. Conflating the two would report every described-on-the-wrapper field as
  // missing, which is the opposite mistake.
  const shape = unwrap(original);
  if (shape instanceof z.ZodObject) {
    if (!describedSomewhere(original)) missing.push(`${path} — object has no .describe()`);
    for (const [key, field] of Object.entries(shape.shape)) {
      const fieldSchema = field as z.ZodType;
      if (!describedSomewhere(fieldSchema)) missing.push(`${path}.${key} — field has no .describe()`);
      collectMissing(fieldSchema, `${path}.${key}`, missing);
    }
  } else if (shape instanceof z.ZodUnion || shape instanceof z.ZodEnum) {
    if (!describedSomewhere(original)) missing.push(`${path} — enum/union has no .describe()`);
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
