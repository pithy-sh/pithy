// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { pii } from "./classes";
import { classifyPrivacy, MAX_CLASSIFIED_POSITIONS, MAX_RECURSION_DEPTH } from "./classify";
import { redact } from "./redact";
import type { REDACT_RECURSION_DEPTH, Redacted } from "./types";

/**
 * **One recursion limit** (#132, the redaction contract, item 6). Every recursion is walked the same way, to one depth
 * in levels of nesting, and masked whole past it. `Redacted<T>` types it `unknown` from the same depth. Nothing tells
 * one recursion from another, so the answer for a schema and a value is a function of them alone.
 */

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};

type Link = { e: string; next?: Link };

/** A linked list `n` nodes long, its marked values `S-0` … */
function list(n: number): Link {
  let at: Link = { e: `S-${n - 1}` };
  for (let index = n - 2; index >= 0; index -= 1) at = { e: `S-${index}`, next: at };
  return at;
}

/** What a redacted list holds at each level: `[pii]` while walked, then the masked node and what is past it. */
function levels(out: unknown): { walked: number; last: unknown } {
  let walked = 0;
  let at = out as { e: unknown; next?: unknown };
  while (at.e === "[pii]" && typeof at.next === "object" && at.next !== null) {
    walked += 1;
    at = at.next as typeof at;
  }
  return { walked, last: at };
}

/** A getter that returns one schema: a recursion defined once. */
const Item = z.object({
  e: pii(z.string()),
  get next() {
    return Item.optional();
  },
});

/** A getter that builds a new schema each read. */
const fresh = () =>
  z.object({
    e: pii(z.string()),
    get next() {
      return fresh().optional();
    },
  });

/** A lazy, defined once and built anew. */
const Lazy: z.ZodType<Link> = z.lazy(() => z.object({ e: pii(z.string()), next: Lazy.optional() }));
const freshLazy = (): z.ZodType<Link> => z.lazy(() => z.object({ e: pii(z.string()), next: freshLazy().optional() }));

/** One node of a list, `depth` levels down, as `redact` returns it, with its fields past the limit. */
const lastNode = { e: "[secret]", next: "[secret]" };

describe("one recursion limit, however the recursion is written", () => {
  test("the runtime and the type read one constant", () => {
    same<REDACT_RECURSION_DEPTH, typeof MAX_RECURSION_DEPTH>();
    expect(MAX_RECURSION_DEPTH).toBe(256);
  });

  test("a getter that returns one schema, one that builds a new one each read, and a lazy all end at one depth", () => {
    const value = list(MAX_RECURSION_DEPTH + 40);
    const schemas: [string, z.ZodType][] = [
      ["getter, one schema", Item],
      ["getter, a new schema each read", fresh()],
      ["lazy, defined once", Lazy],
      ["lazy, built anew", freshLazy()],
    ];
    const results = schemas.map(([, schema]) => redact(schema, schema.parse(value) as never));
    for (const out of results) {
      // The root is at depth 0, so the node at the limit is the last one walked: its fields are past it.
      expect(levels(out)).toEqual({ walked: MAX_RECURSION_DEPTH, last: lastNode });
    }
    // Read by parse first or not, the same.
    for (const [, schema] of schemas) expect(redact(schema, value as never)).toEqual(results[0]);
    // At the limit and short of it: a list that ends before the limit is walked to its end.
    const short = list(MAX_RECURSION_DEPTH);
    for (const [, schema] of schemas) {
      expect(levels(redact(schema, short as never))).toEqual({ walked: MAX_RECURSION_DEPTH - 1, last: { e: "[pii]" } });
    }
    const atLimit = list(MAX_RECURSION_DEPTH + 1);
    for (const [, schema] of schemas) {
      expect(levels(redact(schema, atLimit as never))).toEqual({
        walked: MAX_RECURSION_DEPTH,
        last: { e: "[secret]" },
      });
    }
  });

  test("Redacted<T> keeps the shape to the limit and is unknown from the same depth", () => {
    /** The node `N` levels down a redacted list's type. Tail-recursive, so it reaches the limit. */
    type Nth<T, N extends number, I extends unknown[] = []> = I["length"] extends N
      ? T
      : T extends { next?: infer X }
        ? Nth<NonNullable<X>, N, [...I, 0]>
        : never;
    type Limit = typeof MAX_RECURSION_DEPTH;
    type Prior = 255;
    // A getter that returns one schema.
    type One = Redacted<typeof Item>;
    same<Nth<One, Prior>["e"], string>();
    same<Nth<One, Limit>["e"], unknown>();
    same<Nth<One, Limit>["next"], unknown>();
    // A getter that builds a new schema each read: the same type, as it is the same value.
    type Fresh = Redacted<ReturnType<typeof fresh>>;
    same<Nth<Fresh, Prior>["e"], string>();
    same<Nth<Fresh, Limit>["e"], unknown>();
    // A lazy is annotated `z.ZodType<T>`, which names no kind: `unknown` at every depth, the limit included.
    same<Redacted<typeof Lazy>, unknown>();
    // And the runtime agrees with each at the same depths.
    const out = redact(Item, list(MAX_RECURSION_DEPTH + 2) as never);
    let at: unknown = out;
    for (let index = 0; index < MAX_RECURSION_DEPTH; index += 1) at = (at as { next: unknown }).next;
    expect(at).toEqual(lastNode);
    let prior: unknown = out;
    for (let index = 0; index < MAX_RECURSION_DEPTH - 1; index += 1) prior = (prior as { next: unknown }).next;
    expect((prior as { e: unknown }).e).toBe("[pii]");
  });

  test("counts every level of nesting, an array's as much as an object's", () => {
    const Tree = z.object({
      id: z.number(),
      get children() {
        return z.array(Tree);
      },
    });
    type Node = { id: number | string; children: Node[] | string };
    const tree = (n: number): Node => ({ id: n, children: n === 0 ? [] : [tree(n - 1)] });
    let at = redact(Tree, tree(400) as never) as Node;
    let objects = 1;
    while (Array.isArray(at.children) && at.children[0]) {
      at = at.children[0];
      objects += 1;
    }
    // An object and an array a level: the object at the limit is the last walked, and its fields are masked.
    expect(objects).toBe(MAX_RECURSION_DEPTH / 2 + 1);
    expect(at).toEqual({ id: "[secret]", children: "[secret]" });
    // Thousands of levels deep, it never throws and never leaks: every node past the limit is gone with it.
    const long = JSON.stringify(redact(Item, list(5_000) as never));
    expect(long).not.toMatch(/S-\d/);
  });

  test("a schema field shared by two holders reads alike whichever holder is read first", () => {
    const run = (order: "A-first" | "B-first") => {
      const shared = fresh().optional();
      const A = z.object({ e: pii(z.string()), next: shared });
      const B = z.object({ id: z.string(), n: shared });
      const a = { e: "S-1", next: { e: "S-2", next: { e: "S-3" } } };
      const b = { id: "P-1", n: { e: "S-3", next: { e: "S-4" } } };
      const readA = () => ({ redact: redact(A, A.parse(a) as never), classify: classifyPrivacy(A) });
      const readB = () => ({ redact: redact(B, B.parse(b) as never), classify: classifyPrivacy(B) });
      if (order === "A-first") {
        const first = readA();
        return { A: first, B: readB() };
      }
      const second = readB();
      return { A: readA(), B: second };
    };
    const aFirst = run("A-first");
    const bFirst = run("B-first");
    expect(aFirst).toEqual(bFirst);
    expect(aFirst.A.redact).toEqual({ e: "[pii]", next: { e: "[pii]", next: { e: "[pii]" } } });
    expect(aFirst.B.redact).toEqual({ id: "P-1", n: { e: "[pii]", next: { e: "[pii]" } } });
  });

  test("classifyPrivacy lists a recursion defined once once, and one built anew to the limit, alike before parse", () => {
    expect(classifyPrivacy(Item)).toEqual([{ path: "e", class: "pii" }]);
    expect(classifyPrivacy(Lazy)).toEqual([{ path: "e", class: "pii" }]);
    const path = (depth: number, key: string) => [...Array(depth).fill("next"), key].join(".");
    const expected = [
      ...Array.from({ length: MAX_RECURSION_DEPTH }, (_, depth) => ({ path: path(depth, "e"), class: "pii" })),
      { path: path(MAX_RECURSION_DEPTH, "e"), class: "secret", truncated: true },
      { path: path(MAX_RECURSION_DEPTH, "next"), class: "secret", truncated: true },
    ];
    expect(classifyPrivacy(fresh())).toEqual(expected);
    expect(classifyPrivacy(freshLazy())).toEqual(expected);
    const parsed = fresh();
    parsed.parse(list(5));
    expect(classifyPrivacy(parsed)).toEqual(expected);
  });

  test("classifyPrivacy ends fast on a schema that builds two new ones at every level", () => {
    const wide = (): z.ZodType => z.lazy(() => z.object({ a: wide().optional(), b: wide().optional() }));
    const started = Date.now();
    const listed = classifyPrivacy(z.object({ id: z.string(), tree: wide() }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(listed.length).toBeGreaterThan(0);
    for (const field of listed) {
      expect(field).toMatchObject({ class: "secret", truncated: true });
      expect(field.path.startsWith("tree.")).toBe(true);
    }
    expect(MAX_CLASSIFIED_POSITIONS).toBe(10_000);
  });

  test("classifyPrivacy reads a tree built anew level by level, so a shallow branch is listed as redact masks it", () => {
    const node = (): z.ZodType =>
      z.object({
        e: pii(z.string()),
        u: z.string(),
        get left() {
          return node().optional();
        },
        get right() {
          return node().optional();
        },
      });
    const Tree = node();
    const listed = classifyPrivacy(Tree);
    const depth = (path: string) => path.split(".").length;
    // Every level read whole lists its `e` at every path, left or right; the first level past the budget is 13.
    const truncated = listed.filter((field) => field.truncated);
    expect(truncated.length).toBeGreaterThan(0);
    expect(Math.min(...truncated.map((field) => depth(field.path)))).toBe(13);
    expect(listed).toContainEqual({ path: "right.e", class: "pii" });
    expect(listed).toContainEqual({ path: "left.right.left.e", class: "pii" });
    expect(listed.some((field) => field.path === "right" || field.path.startsWith("right.u"))).toBe(false);
    const out = redact(Tree, Tree.parse({ e: "S-a", u: "P-a", right: { e: "S-b", u: "P-b" } }) as never);
    expect(out).toEqual({ e: "[pii]", u: "P-a", right: { e: "[pii]", u: "P-b" } });
    // In the schema's own order, as a schema read to the end is.
    expect(listed.slice(0, 3)).toEqual([
      { path: "e", class: "pii" },
      { path: "left.e", class: "pii" },
      { path: "left.left.e", class: "pii" },
    ]);
  });

  test("Redacted<T> keeps the output of an opaque node with nothing marked beneath, however deep or recursive", () => {
    const Node = z.object({
      u: z.string(),
      get next() {
        return Node.optional();
      },
    });
    const Row = z.object({ id: z.string(), tree: Node.transform((n) => n), email: pii(z.string()) });
    const value = Row.parse({ id: "1", tree: { u: "P-1", next: { u: "P-2" } }, email: "S-1" });
    expect(redact(Row, value)).toEqual({ id: "1", tree: { u: "P-1", next: { u: "P-2" } }, email: "[pii]" });
    expect(classifyPrivacy(Row)).toEqual([{ path: "email", class: "pii" }]);
    same<Redacted<typeof Row>["tree"], z.output<typeof Node>>();
    // Fourteen levels of unmarked objects under a transform, past where a bounded search would stop.
    const Deep = z
      .object({
        a: z.object({
          a: z.object({
            a: z.object({
              a: z.object({
                a: z.object({
                  a: z.object({
                    a: z.object({
                      a: z.object({
                        a: z.object({
                          a: z.object({ a: z.object({ a: z.object({ a: z.object({ a: z.string() }) }) }) }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      })
      .transform((x) => x);
    same<Redacted<typeof Deep>, z.output<typeof Deep>>();
    // And a mark at the bottom of the same depth is still found, and the position typed unknown.
    const DeepMarked = z
      .object({
        a: z.object({
          a: z.object({
            a: z.object({
              a: z.object({
                a: z.object({
                  a: z.object({
                    a: z.object({
                      a: z.object({
                        a: z.object({
                          a: z.object({ a: z.object({ a: z.object({ a: z.object({ a: pii(z.string()) }) }) }) }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      })
      .transform((x) => x);
    same<Redacted<typeof DeepMarked>, unknown>();
  });
});
