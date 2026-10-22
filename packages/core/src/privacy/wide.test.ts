// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { pii } from "./classes";
import { classifyPrivacy, hasPrivacy, walkPrivacy } from "./classify";
import { redact } from "./redact";

/**
 * **A wide value and a wide schema** (#132). No list sized by the value or the schema is ever spread into a call, so an
 * array, a record or a map of hundreds of thousands of entries, and an object of hundreds of thousands of fields, never
 * throw a `RangeError`. And masked keys and elements that mask alike are numbered in one pass, never by scanning from
 * `#2` for each one.
 */

const WIDE = 300_000;

describe("a wide value", () => {
  test("redacts an array, a record and a map of 300,000 entries without throwing", () => {
    const Ids = z.object({ ids: z.array(z.string()), e: pii(z.string()) });
    const ids = Array.from({ length: WIDE }, (_, index) => `id${index}`);
    const row = redact(Ids, { ids, e: "S-1" } as never) as { ids: string[]; e: string };
    expect(row.ids).toHaveLength(WIDE);
    expect(row.ids[WIDE - 1]).toBe(`id${WIDE - 1}`);
    expect(row.e).toBe("[pii]");

    const Notes = z.record(z.string(), pii(z.string()));
    const notes: Record<string, string> = {};
    for (let index = 0; index < WIDE; index += 1) notes[`k${index}`] = `S-${index}`;
    const record = redact(Notes, notes as never) as Record<string, unknown>;
    expect(Object.keys(record)).toHaveLength(WIDE);
    expect(record.k0).toBe("[pii]");

    const ByKey = z.map(z.string(), pii(z.string()));
    const map = redact(
      ByKey,
      new Map(Array.from({ length: WIDE }, (_, index) => [`k${index}`, `S-${index}`])) as never,
    ) as Map<string, unknown>;
    expect(map.size).toBe(WIDE);
    expect(map.get("k0")).toBe("[pii]");
  });
});

describe("a wide schema", () => {
  /** An object of 300,000 unmarked fields and one marked one, and a value for it. */
  function wide() {
    const s = z.string();
    const shape: Record<string, z.ZodType> = {};
    const value: Record<string, string> = {};
    for (let index = 0; index < WIDE; index += 1) {
      shape[`f${index}`] = s;
      value[`f${index}`] = "x";
    }
    shape.e = pii(z.string());
    value.e = "S-1";
    return { schema: z.object(shape), value };
  }

  test("classifyPrivacy, hasPrivacy, walkPrivacy and redact read an object of 300,000 fields without throwing", () => {
    const { schema, value } = wide();
    expect(() => classifyPrivacy(schema)).not.toThrow();
    expect(classifyPrivacy(schema).some((field) => field.class === "pii")).toBe(true);
    expect(hasPrivacy(schema, "pii")).toBe(true);
    let marked = 0;
    expect(() =>
      walkPrivacy(schema, {
        marked() {
          marked += 1;
        },
      }),
    ).not.toThrow();
    expect(marked).toBeGreaterThan(0);
    const out = redact(schema, value) as Record<string, unknown>;
    expect(out.e).not.toBe("S-1");
    expect(Object.keys(out)).toHaveLength(WIDE + 1);
  });
});

/** The names the quadratic rename gave: every kept one as it is, each masked one the first name nothing holds yet. */
function reference(items: readonly { value: unknown; masked: boolean }[]): unknown[] {
  const taken = new Set<unknown>(items.filter((item) => !item.masked).map((item) => item.value));
  return items.map((item) => {
    if (!item.masked) return item.value;
    let name = item.value;
    if (typeof name === "string" && taken.has(name)) {
      let index = 2;
      while (taken.has(`${item.value} #${index}`)) index += 1;
      name = `${item.value} #${index}`;
    }
    taken.add(name);
    return name;
  });
}

describe("masked keys and elements that mask alike", () => {
  const MANY = 200_000;

  /** How long `redact` takes over a value, and what it returned. */
  function timed(schema: z.ZodType, value: unknown): { ms: number; out: unknown } {
    const started = performance.now();
    const out = redact(schema, value as never);
    return { ms: performance.now() - started, out };
  }

  test("number 200,000 masked record keys, map keys and set elements apart in one pass, as fast as kept ones", () => {
    const emails = Array.from({ length: MANY }, (_, index) => `u${index}@x.io`);
    const record: Record<string, string> = {};
    for (const email of emails) record[email] = "v";
    const map = new Map(emails.map((email) => [email, "v"]));
    const set = new Set(emails);
    const cases: [string, z.ZodType, z.ZodType, unknown, (out: unknown) => unknown[]][] = [
      [
        "record",
        z.record(pii(z.string()), z.string()),
        z.record(z.string(), z.string()),
        record,
        (out) => Object.keys(out as object),
      ],
      [
        "map",
        z.map(pii(z.string()), z.string()),
        z.map(z.string(), z.string()),
        map,
        (out) => [...(out as Map<unknown, unknown>).keys()],
      ],
      ["set", z.set(pii(z.string())), z.set(z.string()), set, (out) => [...(out as Set<unknown>)]],
    ];
    for (const [name, masked, kept, value, names] of cases) {
      const baseline = timed(kept, value);
      const run = timed(masked, value);
      const out = names(run.out);
      expect(out, name).toHaveLength(MANY);
      expect(out[0], name).toBe("[pii]");
      expect(out[MANY - 1], name).toBe(`[pii] #${MANY}`);
      // The scan from `#2` for each key took minutes here, thousands of times the walk alone. One pass costs about what
      // walking the keys kept costs, on an idle machine or a loaded one: a fraction of a second on an idle one.
      expect(run.ms, `${name}: ${Math.round(run.ms)} ms against ${Math.round(baseline.ms)} ms kept`).toBeLessThan(
        5 * baseline.ms + 100,
      );
    }
  });

  test("name every masked element exactly as the first-free-name scan did, kept ones beside them", () => {
    // Numbers are masked `[pii]`, strings are kept: so a kept string can hold a name a masked number would take.
    const Mixed = z.set(z.union([pii(z.number()), z.string()]));
    const pool: unknown[] = ["[pii]", "[pii] #2", "[pii] #3", "[pii] #5", "[pii] #2 #2", "P-1"];
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 500; round += 1) {
      const items = new Set<unknown>();
      const size = 1 + Math.floor(random() * 10);
      for (let index = 0; index < size; index += 1)
        items.add(random() < 0.5 ? index : pool[Math.floor(random() * pool.length)]);
      const order = [...items];
      const expected = reference(
        order.map((item) => ({ value: typeof item === "number" ? "[pii]" : item, masked: typeof item === "number" })),
      );
      expect([...redact(Mixed, new Set(order) as never)]).toEqual(expected);
    }
  });
});
