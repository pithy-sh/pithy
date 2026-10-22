// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { pii, secret } from "./classes";
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

describe("a union of many object options", () => {
  const OPTIONS = 1_600;
  const KEYS = 40_000;

  /** How long `run` takes, the faster of two tries, and what it returned. */
  function timed<T>(run: () => T): { ms: number; out: T } {
    let started = performance.now();
    let out = run();
    const first = performance.now() - started;
    started = performance.now();
    out = run();
    return { ms: Math.min(first, performance.now() - started), out };
  }

  test("redacts 40,000 keys at a union of 1,600 objects, one of them loose, in about the time parse takes", () => {
    const options: z.ZodType[] = [z.looseObject({ id: pii(z.string()) })];
    for (let index = 0; index < OPTIONS; index += 1) options.push(z.object({ [`k${index}`]: z.string() }));
    const schema = z.union(options as [z.ZodType, z.ZodType]);
    const value: Record<string, string> = { id: "S-1" };
    for (let index = 0; index < KEYS; index += 1) value[`x${index}`] = `v${index}`;
    const parse = timed(() => schema.parse(value));
    const run = timed(() => redact(schema, parse.out as never) as Record<string, string>);
    expect(Object.keys(run.out)).toHaveLength(KEYS + 1);
    expect(run.out.id).toBe("[pii]");
    expect(run.out[`x${KEYS - 1}`]).toBe(`v${KEYS - 1}`);
    // Each key was looked up across every option: seconds here, hundreds of times parse. An index of the options' keys
    // costs a lookup a key, a small multiple of what parse costs to pass the keys through.
    expect(run.ms, `${Math.round(run.ms)} ms against ${Math.round(parse.ms)} ms parse`).toBeLessThan(
      20 * parse.ms + 300,
    );
  });

  /**
   * A union of `count` objects, each naming three keys of its own with one schema behind them all, so the call reads
   * well inside its budget; or, `tagged`, a discriminated union whose options each hold a tag beside two keys. Each odd
   * option's first key is marked. Beside it, one object naming every key: the walk has always read that a lookup a key.
   */
  function options(count: number, tagged: boolean) {
    const kept = z.string();
    const marked = pii(z.string());
    const shapes: Record<string, z.ZodType>[] = [];
    const rows: Record<string, string>[] = [];
    for (let option = 0; option < count; option += 1) {
      const shape: Record<string, z.ZodType> = tagged ? { t: z.literal(`t${option}`) } : {};
      const row: Record<string, string> = tagged ? { t: `t${option}` } : {};
      for (let slot = 0; slot < (tagged ? 2 : 3); slot += 1) {
        shape[`k${option}_${slot}`] = slot === 0 && option % 2 ? marked : kept;
        row[`k${option}_${slot}`] = `S-${option}_${slot}`;
      }
      shapes.push(shape);
      rows.push(row);
    }
    const schema = tagged
      ? z.array(z.discriminatedUnion("t", shapes.map((shape) => z.object(shape)) as never))
      : z.array(z.union(shapes.map((shape) => z.strictObject(shape)) as never));
    const flatShape: Record<string, z.ZodType> = {};
    const flatRow: Record<string, string> = {};
    for (const [index, shape] of shapes.entries()) {
      for (const [key, each] of Object.entries(shape)) if (key !== "t") flatShape[key] = each;
      for (const [key, each] of Object.entries(rows[index] as object)) if (key !== "t") flatRow[key] = each;
    }
    return { schema, rows, flat: z.array(z.object(flatShape)), flatRows: [flatRow] };
  }

  test("lists, checks and redacts a union of objects that each name keys of their own in linear time", () => {
    // A thousand tagged options are what the budget reads whole: each tag is a schema of its own.
    for (const [name, count, tagged] of [
      ["union", OPTIONS, false],
      ["discriminated union", 1_000, true],
    ] as const) {
      const { schema, rows, flat, flatRows } = options(count, tagged);
      const parsed = schema.parse(rows);
      const flatParsed = flat.parse(flatRows);
      const listed = timed(() => classifyPrivacy(schema));
      const has = timed(() => hasPrivacy(schema, "phi"));
      const out = timed(() => redact(schema, parsed as never) as Record<string, string>[]);
      expect(
        listed.out.filter((field) => field.truncated),
        name,
      ).toEqual([]);
      expect(listed.out, name).toHaveLength(count / 2);
      expect(has.out, name).toBe(false);
      expect(out.out[1]?.k1_0, name).toBe("[pii]");
      expect(out.out[1]?.k1_1, name).toBe("S-1_1");
      // Each key the position names was looked up across every option: a call grew as the square of the options, a
      // hundred times the flat object here. Indexed, it costs about what the flat object costs.
      for (const [call, ms, flatMs] of [
        ["classifyPrivacy", listed.ms, timed(() => classifyPrivacy(flat)).ms],
        ["hasPrivacy", has.ms, timed(() => hasPrivacy(flat, "phi")).ms],
        ["redact", out.ms, timed(() => redact(flat, flatParsed as never)).ms],
      ] as const)
        expect(ms, `${name} ${call}: ${Math.round(ms)} ms against ${Math.round(flatMs)} ms flat`).toBeLessThan(
          10 * flatMs + 60,
        );
    }
  });

  test("reads each key through the options in their order, a catchall where an option does not name it", () => {
    const Open = z.object({ a: z.string() }).catchall(pii(z.string()));
    const Loose = z.looseObject({ b: secret(z.string()) });
    const Strict = z.strictObject({ a: secret(z.number()), c: z.string() });
    const schema = z.union([Open, Loose, Strict, z.record(z.string(), z.boolean())]);
    // Pinned as the scan across every option read them: the index must read each key to the same schemas.
    expect(classifyPrivacy(schema)).toEqual([
      { path: "a", class: "secret" },
      { path: "b", class: "pii" },
      { path: "b", class: "secret" },
      { path: "c", class: "pii" },
      { path: "*", class: "pii" },
    ]);
    expect(redact(schema, { a: "A", b: "B", c: "C", d: "D" } as never)).toEqual({
      a: "[secret]",
      b: "[secret]",
      c: "[pii]",
      d: "[pii]",
    });
    expect(redact(schema, { b: "B", z: 1 } as never)).toEqual({ b: "[secret]", z: "[pii]" });
    expect(redact(schema, { a: 5, c: "C" } as never)).toEqual({ a: "[secret]", c: "[pii]" });
  });
});
