// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { refusesVanishingKey } from "../capability/vanishingKey";
import { PithyError } from "../error/pithyError";
import { childSchemas, describedInChain, undescribed, undescribedExports } from "./describedness";

/**
 * The gate over the nineteen gates. Every package's `schema-descriptions.test.ts` is now a glob, three
 * floors and a call into this module, so a defect here is a defect in all nineteen at once — and the
 * defect that matters is not a false report, it is a walk that stops early and reports nothing.
 *
 * Each container below is one the pre-#351 copies stopped at.
 */

/** The complaints from walking one schema. */
function walk(schema: z.ZodType): string[] {
  return undescribed(schema, "sample").missing;
}

describe("the walk reaches through every container", () => {
  test("an array is not transparent — an object inside one is still checked", () => {
    expect(walk(z.array(z.object({ a: z.string() })))).toEqual([
      "sample[array:0] — object has no .describe()",
      "sample[array:0].a — field has no .describe()",
    ]);
    // Describing the list says nothing about the shape of its elements. This is the gap #326 found.
    expect(walk(z.array(z.object({ a: z.string().describe("d") })).describe("d"))).toEqual([
      "sample[array:0] — object has no .describe()",
    ]);
  });

  test("record, union, tuple, set, intersection and nullable all hand over their inside", () => {
    expect(walk(z.record(z.string(), z.object({ a: z.string() })).describe("d"))).toHaveLength(2);
    expect(walk(z.union([z.object({ a: z.string() })]).describe("d"))).toHaveLength(2);
    expect(walk(z.tuple([z.object({ a: z.string() })]))).toHaveLength(2);
    expect(walk(z.set(z.object({ a: z.string() })).describe("d"))).toHaveLength(2);
    expect(walk(z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })).describe("d"))).toHaveLength(
      4,
    );
    expect(walk(z.object({ a: z.string() }).nullable().describe("d"))).toEqual([
      "sample[nullable:0].a — field has no .describe()",
    ]);
  });

  test("a pipe is stepped through, and a codec is not", () => {
    // Wrapping an object in a guard must not remove it from the sweep. `refusesVanishingKey` and
    // anything else that pipes into a schema is the real case.
    const guarded = refusesVanishingKey(z.object({ a: z.string() }), "A sample");
    expect(walk(guarded)).toEqual([
      "sample[pipe:1] — object has no .describe()",
      "sample[pipe:1].a — field has no .describe()",
    ]);
    // A codec is the CLAUDE.md §Zod exemption spelled as a type: it stops the walk, and nothing else does.
    const codec = z.codec(z.number(), z.date(), {
      decode: (value) => new Date(value),
      encode: (value) => value.getTime(),
    });
    expect(walk(z.object({ at: codec.describe("d") }).describe("d"))).toEqual([]);
    expect(childSchemas(codec, "sample")).toEqual([]);
  });

  test("a kind it has never met throws, rather than passing as a leaf", () => {
    const alien = { def: { type: "quantum" } } as unknown as z.ZodType;
    expect(() => childSchemas(alien, "sample")).toThrow(PithyError);
    expect(() => childSchemas(alien, "sample")).toThrow(/never been taught/);
  });
});

describe("a transparent wrapper and its inside are one described thing", () => {
  test("the description is found whichever side of the wrapper it was written on", () => {
    expect(describedInChain(z.string().describe("d").optional())).toBe(true);
    expect(describedInChain(z.string().optional().describe("d"))).toBe(true);
    expect(describedInChain(z.string().describe("d").nullable().default("x"))).toBe(true);
    expect(describedInChain(z.string().optional())).toBe(false);
  });

  test("but an array is not a transparent wrapper, so a described element does not describe the field", () => {
    expect(describedInChain(z.array(z.string().describe("d")))).toBe(false);
    expect(describedInChain(z.array(z.string()).describe("d"))).toBe(true);
  });

  test("and the object under a described wrapper is documented, one level only", () => {
    expect(
      walk(
        z
          .object({ a: z.string().describe("d") })
          .describe("d")
          .optional(),
      ),
    ).toEqual([]);
    expect(
      walk(
        z
          .union([z.string(), z.literal("")])
          .optional()
          .describe("d"),
      ),
    ).toEqual([]);
    expect(walk(z.object({ a: z.string() }).optional().describe("d"))).toEqual([
      "sample[optional:0].a — field has no .describe()",
    ]);
  });
});

describe("the walk counts what it looked at", () => {
  test("fields are counted, so an empty walk is visible as an empty walk", () => {
    const documented = z.object({ a: z.string().describe("d"), b: z.string().describe("d") }).describe("d");
    expect(undescribed(documented).fields).toBe(2);
    expect(undescribed(z.string()).fields).toBe(0);
  });

  test("undescribedExports reports the modules and schemas it was handed, not what it found", () => {
    const described = z.object({ a: z.string().describe("d") }).describe("d");
    const result = undescribedExports({
      "./one.ts": { A: described, notASchema: 7 },
      "./two.ts": { B: described.describe("e") },
      "./empty.ts": {},
    });
    expect(result.modules).toBe(3);
    expect(result.schemas).toBe(2);
    expect(result.fields).toBe(2);
    expect(result.missing).toEqual([]);
    // An empty glob reports zero rather than a clean bill of health. This is the whole point of #351.
    expect(undescribedExports({})).toEqual({ missing: [], fields: 0, modules: 0, schemas: 0 });
  });

  test("a schema reached twice is walked once, and its fields counted once", () => {
    const shared = z.object({ a: z.string().describe("d") }).describe("d");
    expect(undescribedExports({ "./one.ts": { A: shared, B: shared } }).fields).toBe(1);
  });
});
