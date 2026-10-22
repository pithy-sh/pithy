// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { phi, pii } from "./classes";
import { classifyPrivacy, hasPrivacy, MAX_READ_SCHEMAS, unreadClasses, walkPrivacy } from "./classify";
import { redact } from "./redact";

/**
 * **One budget per call** (#132). `redact`, `classifyPrivacy`, `hasPrivacy` and `walkPrivacy` each read at most
 * {@link MAX_READ_SCHEMAS} schemas in one call, every position and every search in it drawing on the one budget. A
 * schema that builds a new one at every read, with a marked container or an opaque node at every level, once cost each
 * position a budget of its own: positions times ten thousand schemas, gigabytes for a value twenty levels deep.
 */

/** RSS growth one call may cause, with the schema and the value already built. */
const CEILING = 64 * 1024 * 1024;

/** Builds past which a factory stops building, so a reader without one budget ends, and fails the count. */
const VALVE = 40_000;

/**
 * Three factories that build a new schema at every read: `a` a lazy field and a transform over an object holding a
 * lazy, `b` the same with a second lazy field, `m` a marked container in place of the transform. Each counts what it
 * builds.
 */
function factories() {
  let built = 0;
  const stop = z.object({});
  const more = () => {
    built += 1;
    return built <= VALVE;
  };
  const a = (): z.ZodType =>
    more()
      ? z.object({
          a: z.lazy(a).optional(),
          j: z
            .object({ x: z.lazy(a).optional() })
            .transform((x) => x)
            .optional(),
        })
      : stop;
  const b = (): z.ZodType =>
    more()
      ? z.object({
          a: z.lazy(b).optional(),
          b: z.lazy(b).optional(),
          j: z
            .object({ x: z.lazy(b).optional() })
            .transform((x) => x)
            .optional(),
        })
      : stop;
  const m = (): z.ZodType =>
    more() ? z.object({ a: z.lazy(m).optional(), m: pii(z.object({ x: z.lazy(m).optional() })).optional() }) : stop;
  return { built: () => built, variants: { a, b, m } };
}

type Variant = "a" | "b" | "m";

/** A value twenty levels deep down `a`, with the container or the opaque field set at each level. */
function deep(variant: Variant): unknown {
  let value: Record<string, unknown> = {};
  for (let level = 0; level < 20; level += 1) value = variant === "m" ? { a: value, m: {} } : { a: value, j: {} };
  return value;
}

/** Each reader, readied: what it needs built first is built before the call is measured. Parse builds what it reads. */
const readers: [string, (schema: z.ZodType, variant: Variant) => () => unknown][] = [
  ["classifyPrivacy", (schema) => () => classifyPrivacy(schema)],
  ["hasPrivacy", (schema) => () => hasPrivacy(schema, "pii")],
  ["walkPrivacy", (schema) => () => walkPrivacy(schema, { marked: () => undefined })],
  [
    "redact",
    (schema, variant) => {
      const value = schema.parse(deep(variant));
      return () => redact(schema, value as never);
    },
  ],
];

const cases = readers.flatMap(([reader, run]) =>
  (["a", "b", "m"] as const).map((variant) => [reader, variant, run] as const),
);

describe("one call reads at most one budget of schemas, whatever the schema builds", () => {
  test("the budget", () => {
    expect(MAX_READ_SCHEMAS).toBe(10_000);
  });

  test.each(cases)("%s, factory %s: builds within the budget, and memory stays under 64 MB", (_, variant, ready) => {
    const { built, variants } = factories();
    const run = ready(variants[variant](), variant);
    const before = built();
    const rss = process.memoryUsage().rss;
    run();
    const grew = process.memoryUsage().rss - rss;
    expect(built() - before).toBeLessThanOrEqual(MAX_READ_SCHEMAS);
    expect(grew).toBeLessThan(CEILING);
  });

  test("the list still names every class it found, and assumes the rest where it ran out", () => {
    const { variants } = factories();
    const schema = variants.m();
    const listed = classifyPrivacy(schema);
    expect(listed).toContainEqual({ path: "m", class: "pii" });
    // Past the budget nothing was read, so any class may be marked there: never less than the schema marks.
    for (const name of unreadClasses()) expect(hasPrivacy(schema, name)).toBe(true);
    for (const field of listed.filter((each) => each.class !== "pii")) expect(field.truncated).toBe(true);
  });

  test("redact masks what it reached and fails closed past the budget, never a raw marked value", () => {
    const { variants } = factories();
    const schema = variants.m();
    let value: Record<string, unknown> = { m: { x: { e: "S-0" } } };
    for (let level = 0; level < 20; level += 1) value = { a: value, m: {} };
    const out = JSON.stringify(redact(schema, schema.parse(value) as never));
    expect(out).not.toMatch(/S-\d/);
    // The shallowest containers are read before the budget runs out, and carry the class they mark.
    expect(out.startsWith('{"a":{"a":')).toBe(true);
    expect(out).toContain('"m":"[pii]"');
  });

  test("every answer is a function of the schema and the value alone, whichever call came first", () => {
    const fresh = () => factories().variants.m();
    const alone = classifyPrivacy(fresh());
    const warmed = fresh();
    redact(warmed, warmed.parse(deep("m")) as never);
    walkPrivacy(warmed, { marked: () => undefined });
    expect(classifyPrivacy(warmed)).toEqual(alone);
    const first = fresh();
    const once = JSON.stringify(redact(first, first.parse(deep("m")) as never));
    classifyPrivacy(first);
    expect(JSON.stringify(redact(first, first.parse(deep("m")) as never))).toBe(once);
  });
});

/** Raw marked values here start `S-`: none may come back. */
function leaked(value: unknown): boolean {
  return /S-\d/.test(JSON.stringify(value) ?? "");
}

describe("schemas that build two or three new ones at every level complete, and leak nothing", () => {
  const w2 = (): z.ZodType => z.object({ a: z.lazy(w2).optional(), b: z.lazy(w2).optional(), e: pii(z.string()) });
  const w3 = (): z.ZodType =>
    z.union([
      z.object({ a: z.lazy(w3).optional(), e: pii(z.string()) }),
      z.object({ b: z.lazy(w3).optional(), n: z.number() }),
    ]);
  const w4 = (): z.ZodType =>
    z.intersection(z.object({ a: z.lazy(w4).optional() }), z.object({ b: z.lazy(w4).optional(), e: pii(z.string()) }));
  const w5 = (): z.ZodType => z.tuple([z.lazy(w5).optional(), z.lazy(w5).optional(), pii(z.string())]);
  const w6 = (): z.ZodType => z.record(z.string(), z.union([z.lazy(w6), pii(z.string())]));
  const w7 = (): z.ZodType =>
    z.object({
      p: z
        .string()
        .transform((x) => x)
        .pipe(z.any())
        .optional(),
      a: z.lazy(w7).optional(),
      b: z.lazy(w7).optional(),
      j: z
        .object({ x: z.lazy(w7).optional() })
        .transform((x) => x)
        .optional(),
    });
  const w8 = (): z.ZodType =>
    z.object({
      get a() {
        return w8().optional();
      },
      get b() {
        return w8().optional();
      },
      get c() {
        return w8().optional();
      },
      e: phi(z.string()),
    });
  const wa = (): z.ZodType =>
    z.object({ a: z.lazy(wa).optional(), b: z.lazy(wa).optional(), e: pii(z.string()).optional() });
  const codec = z.codec(z.string(), wa(), {
    decode: (text: string) => JSON.parse(text),
    encode: (value: unknown) => JSON.stringify(value),
  });
  const shapes: [string, z.ZodType, unknown][] = [
    ["two lazy fields", w2(), { e: "S-1", a: { e: "S-2" }, b: { e: "S-3", b: { e: "S-4" } } }],
    ["a union of two", w3(), { e: "S-1", a: { n: 1 } }],
    ["an intersection of two", w4(), { e: "S-1", a: { e: "S-2" } }],
    ["a tuple of two", w5(), [undefined, [undefined, undefined, "S-2"], "S-1"]],
    ["a record", w6(), { a: { b: "S-1" }, c: "S-2" }],
    ["three fields with a transform", w7(), { a: { b: {} } }],
    ["three getters", w8(), { e: "S-1", a: { e: "S-2", c: { e: "S-3" } } }],
    ["a codec over two", z.object({ j: codec }), { j: '{"a":{"e":"S-1"}}' }],
  ];

  test.each(shapes)("%s: redact and classifyPrivacy end within the budget", (_, schema, wire) => {
    const started = performance.now();
    const value = schema.parse(wire);
    expect(leaked(redact(schema, value as never))).toBe(false);
    expect(classifyPrivacy(schema).length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
