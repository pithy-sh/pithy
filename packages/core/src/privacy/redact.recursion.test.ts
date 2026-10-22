// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { phi, pii, secret } from "./classes";
import {
  classifyPrivacy,
  hasPrivacy,
  MAX_READ_SCHEMAS,
  MAX_RECURSION_DEPTH,
  unreadClasses,
  walkPrivacy,
} from "./classify";
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

/** One node of a list, `depth` levels down, as `redact` returns it, with its fields past the limit: a cutoff, no class. */
const lastNode = { e: "[truncated]", next: "[truncated]" };

/**
 * What the list says at `path` where it found `found` and was cut at the limit on a chain of new schemas: the classes
 * it found, then every other class, assumed and `truncated`, since nothing past the cut was read.
 */
const assumedBeside = (path: string, found: readonly string[]) => [
  ...found.map((name) => ({ path, class: name })),
  ...unreadClasses()
    .filter((name) => !found.includes(name))
    .map((name) => ({ path, class: name, truncated: true })),
];

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
        last: { e: "[truncated]" },
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
    expect(at).toEqual({ id: "[truncated]", children: "[truncated]" });
    // Thousands of levels deep, it never throws and never leaks: every node past the limit is gone with it.
    const long = JSON.stringify(redact(Item, list(5_000) as never));
    expect(long).not.toMatch(/S-\d/);
  });

  test("the cutoff is [truncated] alike for a recursion defined once and one built anew, and only a new one assumes", () => {
    type Plain = { e: string; next?: Plain };
    const Once: z.ZodType<Plain> = z.object({
      e: z.string(),
      get next() {
        return Once.optional();
      },
    }) as never;
    const anew = (): z.ZodType<Plain> =>
      z.object({
        e: z.string(),
        get next() {
          return anew().optional();
        },
      }) as never;
    const value = list(MAX_RECURSION_DEPTH + 44);
    const nth = (out: unknown) => {
      let at = out;
      for (let index = 0; index < MAX_RECURSION_DEPTH + 1; index += 1) at = (at as { next: unknown }).next;
      return at;
    };
    const once = redact(Once, Once.parse(value) as never);
    const built = redact(anew(), anew().parse(value) as never);
    expect(built).toEqual(once);
    // The node at the limit is walked, and its fields, one level past it, are cut off.
    expect(nth(once)).toBe("[truncated]");
    // Defined once, it comes round to a schema already read, so the list names nothing it did not read.
    expect(classifyPrivacy(Once)).toEqual([]);
    expect(hasPrivacy(Once, "secret")).toBe(false);
    // Built anew, it was never read past the limit, so every class is assumed at the cut, and nowhere else.
    const cut = [...Array(MAX_RECURSION_DEPTH).fill("next")].join(".");
    expect(classifyPrivacy(anew())).toEqual([...assumedBeside(`${cut}.e`, []), ...assumedBeside(`${cut}.next`, [])]);
    expect(hasPrivacy(anew(), "secret")).toBe(true);
  });

  test("numbers the [truncated] elements of a set apart, so the copy holds as many as the value did", () => {
    type Bag = { s: Set<string>; next?: Bag };
    const Node: z.ZodType<Bag> = z.object({
      s: z.set(z.string()),
      get next() {
        return Node.optional();
      },
    }) as never;
    // A node at depth d holds its set at d + 1 and the set's elements at d + 2: past the limit at d = limit - 1.
    let at: Bag = { s: new Set(["P-a", "P-b", "P-c"]) };
    for (let index = 0; index < MAX_RECURSION_DEPTH - 1; index += 1) at = { s: new Set(), next: at };
    let out = redact(Node, at as never) as { s: unknown; next?: unknown };
    for (let index = 0; index < MAX_RECURSION_DEPTH - 1; index += 1) out = out.next as typeof out;
    expect(out.s).toEqual(new Set(["[truncated]", "[truncated] #2", "[truncated] #3"]));
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

  test("classifyPrivacy lists a recursion defined once once, one built anew to the limit, and every class past it", () => {
    expect(classifyPrivacy(Item)).toEqual([{ path: "e", class: "pii" }]);
    expect(classifyPrivacy(Lazy)).toEqual([{ path: "e", class: "pii" }]);
    const path = (depth: number, key: string) => [...Array(depth).fill("next"), key].join(".");
    // Past the limit a new schema was never read, so the cut assumes every class there, beside the one it found.
    const expected = [
      ...Array.from({ length: MAX_RECURSION_DEPTH }, (_, depth) => ({ path: path(depth, "e"), class: "pii" })),
      ...assumedBeside(path(MAX_RECURSION_DEPTH, "e"), ["pii"]),
      ...assumedBeside(path(MAX_RECURSION_DEPTH, "next"), []),
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
      expect(field.truncated).toBe(true);
      expect(field.path.startsWith("tree.")).toBe(true);
    }
    // Nothing past the budget was read, so every class may be there: each is listed, and none is assumed away.
    expect(new Set(listed.map((field) => field.class))).toEqual(new Set(["secret", "phi", "pci", "pii"]));
    expect(MAX_READ_SCHEMAS).toBe(10_000);
  });

  test("classifyPrivacy never lists less than a schema marks: a class below the budget is still found", () => {
    // Two new schemas at every level, and one phi field twenty levels down: far below the level the budget runs out on.
    const node = (depth: number): z.ZodType =>
      z.object({
        get l() {
          return node(depth + 1).optional();
        },
        get r() {
          return node(depth + 1).optional();
        },
        ...(depth === 20 ? { x: phi(z.string()) } : {}),
      });
    const Deep = node(0);
    let value: Record<string, unknown> = {};
    const root = value;
    for (let level = 0; level < 20; level += 1) {
      const next = {};
      value.l = next;
      value = next;
    }
    value.x = "S-1";
    expect(JSON.stringify(redact(Deep, Deep.parse(root) as never))).toContain('"x":"[phi]"');
    for (const name of ["phi", "secret", "pci", "pii"]) expect(hasPrivacy(Deep, name)).toBe(true);
    // Every unread position carries the classes it may hold, as a flag beside them.
    const unread = classifyPrivacy(Deep).filter((field) => field.class === "phi");
    expect(unread.length).toBeGreaterThan(0);
    for (const field of unread) expect(field.truncated).toBe(true);
  });

  test("hasPrivacy answers exactly for each class marked inside the budget", () => {
    const markers = { secret, phi, pii } as const;
    for (const [name, mark] of Object.entries(markers)) {
      // A tree built anew at every level that ends at depth 4, so the walk reads it to its end.
      const node = (depth: number): z.ZodType =>
        z.object({
          ...(depth < 4
            ? {
                get l() {
                  return node(depth + 1).optional();
                },
                get r() {
                  return node(depth + 1).optional();
                },
              }
            : {}),
          ...(depth === 3 ? { x: mark(z.string()) } : {}),
        });
      const Tree = node(0);
      expect(hasPrivacy(Tree, name)).toBe(true);
      for (const other of Object.keys(markers).filter((each) => each !== name)) {
        expect(hasPrivacy(Tree, other)).toBe(false);
      }
      const listed = classifyPrivacy(Tree);
      expect(listed.some((field) => field.truncated)).toBe(false);
      expect(listed).toContainEqual({ path: "l.r.l.x", class: name });
    }
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
    // Breadth first: every level the call's budget reaches whole lists its `e` at every path, left or right. Each
    // position costs the schemas its read meets and its shape holds, so the first level the budget runs out on is 10.
    const truncated = listed.filter((field) => field.truncated);
    expect(truncated.length).toBeGreaterThan(0);
    expect(Math.min(...truncated.map((field) => depth(field.path)))).toBe(10);
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

  test("Redacted<T> keeps the output of an opaque node with nothing marked beneath, however deep", () => {
    // A recursion defined once beneath an opaque node is read to its end at runtime, and kept.
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
    // The type cannot tell it from one built anew, which reaches the limit and is masked: it is `unknown`.
    same<Redacted<typeof Row>["tree"], unknown>();
    // A schema used twice at two depths is no recursion, and keeps its output.
    const Tags = z.array(z.string());
    const Shared = z.object({ tags: Tags, items: z.array(z.object({ tags: Tags })) }).transform((x) => x);
    same<Redacted<typeof Shared>, z.output<typeof Shared>>();
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

describe("a recursion that builds a new choice each read never runs past the limit", () => {
  /** A lazy whose target is a union holding a new lazy: no schema is ever met twice. */
  const anew = (): z.ZodType => z.lazy(() => z.union([z.string(), anew()]));
  const beside = (): z.ZodType => z.union([z.number(), anew()]);
  /** Two new ones at every level, on each side of a union and of an intersection. */
  const twice = (): z.ZodType => z.lazy(() => z.union([twice(), twice()]));
  const both = (): z.ZodType => z.lazy(() => z.intersection(both(), both()));
  const marked = (): z.ZodType => z.lazy(() => z.union([pii(z.number()), z.string(), marked()]));
  // One new lazy at every level reaches the limit, and is cut off. Two at every level run out of the call's budget
  // first, and what lies past it was never read: no class was found, so the value is cut off, and every class is listed.
  const cases: [string, () => z.ZodType, unknown, string][] = [
    ["a lazy over a union with a new lazy", anew, "P-1", "[truncated]"],
    ["the same beside a number", beside, "P-1", "[truncated]"],
    ["two new lazies in a union", twice, "P-1", "[truncated]"],
    ["two new lazies in an intersection", both, "P-1", "[truncated]"],
    ["a marked option at every level", marked, 5, "[pii]"],
  ];

  test.each(cases)("redact, classifyPrivacy, hasPrivacy and walkPrivacy never throw: %s", (_, build, value, mask) => {
    const started = Date.now();
    const schema = build();
    expect(() => redact(schema, value as never)).not.toThrow();
    const out = redact(build(), value as never);
    expect(JSON.stringify(out)).not.toMatch(/S-\d/);
    expect(out).toBe(mask);
    expect(() => classifyPrivacy(build())).not.toThrow();
    expect(() => hasPrivacy(build(), "pii")).not.toThrow();
    const walked: string[] = [];
    expect(() =>
      walkPrivacy(build(), { marked: (path, className) => walked.push(`${path} ${className}`) }),
    ).not.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a string past an endless chain of new lazies is cut off as [truncated], and every class is assumed there", () => {
    expect(redact(anew(), "P-1" as never)).toBe("[truncated]");
    expect(redact(beside(), 5 as never)).toBe("[truncated]");
    expect(classifyPrivacy(anew())).toEqual(assumedBeside("", []));
    expect(hasPrivacy(beside(), "secret")).toBe(true);
    // A marked number at every level, and the limit reached: the class is known, so it is the placeholder, and the
    // list names it found beside every class it assumes past the cut.
    expect(redact(marked(), 5 as never)).toBe("[pii]");
    expect(classifyPrivacy(marked())).toEqual(assumedBeside("", ["pii"]));
  });
});

describe("the limit counts nesting, never breadth", () => {
  test("a union of more lazy options than the limit, none nested in another, is walked and kept", () => {
    for (const n of [250, MAX_RECURSION_DEPTH + 4, 600]) {
      const options = Array.from({ length: n }, (_, index) =>
        z.lazy(() => z.object({ t: z.literal(`e${index}`), v: z.string() })),
      );
      const Event = z.union(options as unknown as [z.ZodType, z.ZodType]);
      const value = Event.parse({ t: "e0", v: "P-1" });
      expect(redact(Event, value as never)).toEqual({ t: "e0", v: "P-1" });
      expect(classifyPrivacy(Event)).toEqual([]);
    }
  });

  test("a marked container over a wide union carries the class of its last option, and past the budget assumes it", () => {
    const marked = (width: number) => {
      const options = Array.from({ length: width }, (_, index) => z.object({ [`k${index}`]: z.string() }).strict());
      return pii(z.union([...options, z.object({ last: phi(z.string()) }).strict()] as never));
    };
    const Narrow = marked(1_000);
    expect(redact(Narrow, { last: "S-1" } as never)).toBe("[phi]");
    expect(classifyPrivacy(Narrow)).toEqual([
      { path: "", class: "pii" },
      { path: "", class: "phi" },
    ]);
    // Wider than the call's budget: the last option is never read, so every class is assumed there, and the value is
    // masked with the strongest class found.
    const Wide = marked(MAX_READ_SCHEMAS + 1);
    expect(redact(Wide, { last: "S-1" } as never)).toBe("[pii]");
    const listed = classifyPrivacy(Wide);
    expect(listed).toContainEqual({ path: "", class: "pii" });
    expect(listed).toContainEqual({ path: "", class: "phi", truncated: true });
    expect(hasPrivacy(Wide, "phi")).toBe(true);
  });

  test("an opaque node over a wide unmarked object is kept, and past the budget masked whole", () => {
    const row = (width: number) => {
      const shape = Object.fromEntries(
        Array.from({ length: width }, (_, index) => [`f${index}`, z.object({ x: z.string() })]),
      );
      return z.object({
        id: z.string(),
        blob: z
          .object(shape)
          .partial()
          .transform((x) => x),
      });
    };
    const Narrow = row(1_000);
    const narrow = Narrow.parse({ id: "I-1", blob: { f0: { x: "P-1" } } });
    expect(redact(Narrow, narrow as never)).toEqual({ id: "I-1", blob: { f0: { x: "P-1" } } });
    expect(classifyPrivacy(Narrow)).toEqual([]);
    // Past the budget, what the search never read may hold any class: the value is cut off, and every class listed.
    const Wide = row(MAX_READ_SCHEMAS + 1);
    const wide = Wide.parse({ id: "I-1", blob: { f0: { x: "P-1" } } });
    expect(redact(Wide, wide as never)).toEqual({ id: "I-1", blob: "[truncated]" });
    expect(classifyPrivacy(Wide)).toEqual(
      unreadClasses().map((name) => ({ path: "blob", class: name, truncated: true })),
    );
  });

  test("a union of lazies, none nested in another, is walked and kept, and past the budget masked whole", () => {
    const row = (width: number) =>
      z.object({
        c: z.union(Array.from({ length: width }, (_, index) => z.lazy(() => z.literal(`v${index}`))) as never),
      });
    const Narrow = row(1_000);
    expect(redact(Narrow, Narrow.parse({ c: "v999" }) as never)).toEqual({ c: "v999" });
    expect(classifyPrivacy(Narrow)).toEqual([]);
    const width = MAX_READ_SCHEMAS + 1;
    const Wide = row(width);
    expect(redact(Wide, Wide.parse({ c: `v${width - 1}` }) as never)).toEqual({ c: "[truncated]" });
    expect(classifyPrivacy(Wide)).toEqual(unreadClasses().map((name) => ({ path: "c", class: name, truncated: true })));
  });

  test("a union of shared lazies reads alike whichever union over them is read first", () => {
    const width = 1_000;
    const read = (first: boolean) => {
      const lazies = Array.from({ length: width }, (_, index) => z.lazy(() => z.literal(`v${index}`)));
      const Half = z.object({ c: z.union(lazies.slice(0, width / 2) as never) });
      const All = z.object({ c: z.union(lazies as never) });
      if (first) redact(Half, Half.parse({ c: "v1" }) as never);
      return redact(All, All.parse({ c: `v${width - 1}` }) as never);
    };
    expect(read(false)).toEqual({ c: `v${width - 1}` });
    expect(read(true)).toEqual(read(false));
  });

  test("a chain of lazies nested past the limit is masked, one under it is walked", () => {
    const chain = (n: number): z.ZodType => (n === 0 ? z.string() : z.lazy(() => chain(n - 1)));
    const under = z.object({ v: chain(MAX_RECURSION_DEPTH - 6) });
    expect(redact(under, under.parse({ v: "P-1" }) as never)).toEqual({ v: "P-1" });
    const past = z.object({ v: chain(MAX_RECURSION_DEPTH + 44) });
    expect(redact(past, past.parse({ v: "P-1" }) as never)).toEqual({ v: "[truncated]" });
    expect(classifyPrivacy(past)).toEqual(assumedBeside("v", []));
    expect(classifyPrivacy(under)).toEqual([]);
  });

  test("classifyPrivacy lists a finite schema that reuses one object in many fields to the end", () => {
    const fields = <T extends z.ZodType>(n: number, make: () => T) =>
      Object.fromEntries(Array.from({ length: n }, (_, index) => [`f${index}`, make()]));
    // 22 groups of 22 contacts of 22 addresses: 10,648 addresses, every one the same schema, nothing recursive.
    const Address = z.object({ id: z.string(), line: pii(z.string()) });
    const Contact = z.object(fields(22, () => Address));
    const Group = z.object(fields(22, () => Contact));
    const Book = z.object(fields(22, () => Group));
    const listed = classifyPrivacy(Book);
    expect(listed.filter((field) => field.truncated)).toEqual([]);
    expect(listed).toHaveLength(22 ** 3);
    expect(listed).toContainEqual({ path: "f19.f13.f11.line", class: "pii" });
    expect(listed.every((field) => field.class === "pii" && field.path.endsWith(".line"))).toBe(true);
    expect(hasPrivacy(Book, "secret")).toBe(false);
  });
});

describe("a recursion beneath an opaque node that reaches the limit counts as possibly marked", () => {
  /** A getter that builds a new schema each read, nothing marked in it. */
  const built = () =>
    z.object({
      v: z.string(),
      get next() {
        return built().optional();
      },
    });

  test("its value is masked whole as [truncated], listed with every class assumed, and typed unknown", () => {
    const Row = z.object({ id: z.string(), d: built().transform((x) => x) });
    const value = Row.parse({ id: "1", d: { v: "P-1", next: { v: "P-2" } } });
    expect(redact(Row, value)).toEqual({ id: "1", d: "[truncated]" });
    expect(classifyPrivacy(Row)).toEqual(assumedBeside("d", []));
    expect(hasPrivacy(Row, "secret")).toBe(true);
    same<Redacted<typeof Row>["d"], unknown>();
    const proof: Redacted<typeof Row>["d"] = redact(Row, value).d;
    expect(proof).toBe("[truncated]");
  });

  test("so is a lazy beneath one, whose annotated type the search cannot see inside", () => {
    const Row = z.object({ d: freshLazy().transform((x) => x), l: Lazy.transform((x) => x) });
    const value = Row.parse({ d: { e: "S-1" }, l: { e: "S-2" } });
    // A class known beneath it is its placeholder, cut off or not. Built anew, the search never read past the limit,
    // so it assumes every other class; defined once, it came round to a schema it had read.
    expect(redact(Row, value)).toEqual({ d: "[pii]", l: "[pii]" });
    expect(classifyPrivacy(Row)).toEqual([...assumedBeside("d", ["pii"]), { path: "l", class: "pii" }]);
    same<Redacted<typeof Row>["d"], unknown>();
    same<Redacted<typeof Row>["l"], unknown>();
  });
});

describe("a cutoff ends its own path, and a class known at a position is its placeholder", () => {
  /** Nothing marked: a getter that returns one schema, one that builds a new one each read, and a lazy. */
  const Once: z.ZodType = z.object({
    v: z.string(),
    get next() {
      return Once.optional();
    },
  });
  const built = (): z.ZodType =>
    z.object({
      v: z.string(),
      get next() {
        return built().optional();
      },
    });
  type Plain = { v: string; next?: Plain };
  const Lazy: z.ZodType<Plain> = z.lazy(() => z.object({ v: z.string(), next: Lazy.optional() }));
  const builtLazy = (): z.ZodType<Plain> => z.lazy(() => z.object({ v: z.string(), next: builtLazy().optional() }));
  // Whether each is built anew: a search beneath one never reads past the limit, so it assumes every class there.
  const styles: [string, () => z.ZodType, boolean][] = [
    ["getter, one schema", () => Once, false],
    ["getter, a new schema each read", built, true],
    ["lazy, defined once", () => Lazy, false],
    ["lazy, built anew", builtLazy, true],
  ];
  /** What the list says at `path` for `found`: with every other class assumed where the style is built anew. */
  const listedAt = (path: string, found: string[], anew: boolean) =>
    anew ? assumedBeside(path, found) : found.map((name) => ({ path, class: name }));
  const tree = { v: "P-1", next: { v: "P-2" } };

  test.each(styles)("a marked container over it is masked with its class, one level deep: %s", (_, style, anew) => {
    const Marked = pii(style());
    expect(redact(Marked, tree as never)).toBe("[pii]");
    expect(classifyPrivacy(Marked)).toEqual(listedAt("", ["pii"], anew));
    const Rows = z.array(z.object({ id: z.string(), t: pii(style()) }));
    expect(redact(Rows, [{ id: "1", t: tree }] as never)).toEqual([{ id: "1", t: "[pii]" }]);
    expect(classifyPrivacy(Rows)).toEqual(listedAt("[].t", ["pii"], anew));
  });

  test.each(styles)("a class beside it is carried whatever the field order: %s", (_, style, anew) => {
    const value = { tree, s: "S-1" };
    const first = pii(z.object({ tree: style(), s: secret(z.string()) }));
    const last = pii(z.object({ s: secret(z.string()), tree: style() }));
    for (const Marked of [first, last]) {
      expect(redact(Marked, value as never)).toBe("[secret]");
      expect(classifyPrivacy(Marked)).toEqual(listedAt("", ["pii", "secret"], anew));
      expect(hasPrivacy(Marked, "secret")).toBe(true);
    }
  });

  test.each(styles)("beneath an opaque node, the strongest class found is its placeholder: %s", (_, style, anew) => {
    const value = { x: { tree, s: "S-1" } };
    const first = z.object({ x: z.object({ tree: style(), s: secret(z.string()) }).transform((x) => x) });
    const last = z.object({ x: z.object({ s: secret(z.string()), tree: style() }).transform((x) => x) });
    for (const Row of [first, last]) {
      expect(redact(Row, value as never)).toEqual({ x: "[secret]" });
      expect(classifyPrivacy(Row)).toEqual(listedAt("x", ["secret"], anew));
      expect(hasPrivacy(Row, "secret")).toBe(true);
    }
  });

  test("a schema that builds two new ones at every level is searched shallowest first, and fast", () => {
    const two = (): z.ZodType =>
      z.object({
        get l() {
          return two().optional();
        },
        get r() {
          return two().optional();
        },
      });
    const started = Date.now();
    for (const Marked of [
      pii(z.object({ tree: two(), s: secret(z.string()) })),
      pii(z.object({ s: secret(z.string()), tree: two() })),
    ]) {
      expect(redact(Marked, { tree: {}, s: "S-1" } as never)).toBe("[secret]");
      expect(hasPrivacy(Marked, "secret")).toBe(true);
    }
    // Nothing marked as far as the search reads, and it never ends: past the budget nothing was read, so any class
    // may be marked there. Every class is assumed, each listed truncated, and with none found the value is cut off.
    const Row = z.object({ x: two().transform((x) => x) });
    expect(redact(Row, { x: {} } as never)).toEqual({ x: "[truncated]" });
    expect(classifyPrivacy(Row)).toEqual(unreadClasses().map((name) => ({ path: "x", class: name, truncated: true })));
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a union option beside a choice that never ends is read whatever the option order", () => {
    const anew = (): z.ZodType => z.lazy(() => z.union([z.string(), anew()]));
    for (const Row of [
      z.object({ a: z.union([anew(), secret(z.number())]) }),
      z.object({ a: z.union([secret(z.number()), anew()]) }),
    ]) {
      expect(redact(Row, { a: 5 } as never)).toEqual({ a: "[secret]" });
      // A string reaches the endless chain and no class: it is cut off, and every class is assumed past the cut.
      expect(redact(Row, { a: "P-1" } as never)).toEqual({ a: "[truncated]" });
      expect(classifyPrivacy(Row)).toEqual(assumedBeside("a", ["secret"]));
    }
  });

  test("a lazy whose union reaches itself through another lazy reads as every kind, so it masks more", () => {
    // Documented, never a leak: the cycle is cut where it comes round, and the cut reads as every kind, so the marked
    // option that wraps it applies to every value, an unmarked sibling option's included.
    const A: z.ZodType = z.lazy(() => z.union([z.number(), B]));
    const B: z.ZodType = z.lazy(() => z.union([z.string(), A]));
    const Row = z.object({ f: z.union([z.boolean(), secret(A)]) });
    expect(redact(Row, Row.parse({ f: true }) as never)).toEqual({ f: "[secret]" });
    expect(redact(Row, Row.parse({ f: "P-1" }) as never)).toEqual({ f: "[secret]" });
    // A lazy that reaches itself through one union alone names its kinds, and its sibling keeps its value.
    const L: z.ZodType = z.lazy(() => z.union([z.null(), z.tuple([z.number(), L])]));
    const Listed = z.object({ f: z.union([z.boolean(), secret(L)]) });
    expect(redact(Listed, Listed.parse({ f: true }) as never)).toEqual({ f: true });
  });
});
