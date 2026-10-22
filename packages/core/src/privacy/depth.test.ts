// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { pii, secret } from "./classes";
import {
  classifyPrivacy,
  hasPrivacy,
  MAX_RECURSION_DEPTH,
  type PrivacyField,
  unreadClasses,
  walkPrivacy,
} from "./classify";
import { redact } from "./redact";

/**
 * **The depth limit applies to all nesting, and the list never says less than is marked** (#132, the redaction
 * contract, item 6). Anything nested deeper than {@link MAX_RECURSION_DEPTH} is masked `[truncated]`. A recursion that
 * repeats a position (the same set of schemas) already read on its path needs no cut in the list: its classes are those
 * of the position already read. Where the walk reaches the limit on a chain that keeps producing positions not yet seen
 * on that path, the list assumes every class there, each `truncated`, as it does where the budget runs out.
 */

/** A getter that builds a new schema each read, `depth` levels down to a marked leaf. */
function factory(depth: number): z.ZodType {
  const make = (level: number): z.ZodType =>
    level < depth
      ? z.object({
          id: z.string(),
          get next() {
            return make(level + 1).optional();
          },
        })
      : z.object({ ssn: pii(z.string()) });
  return make(0);
}

/** `levels` plain objects, each written out on its own, around a marked leaf. No recursion at all. */
function nested(levels: number): { schema: z.ZodType; value: unknown } {
  let schema: z.ZodType = z.object({ leaf: pii(z.string()), keep: z.string() });
  let value: unknown = { leaf: "S-1", keep: "k" };
  for (let level = 0; level < levels; level += 1) {
    schema = z.object({ a: schema, keep: z.string() });
    value = { a: value, keep: `k${level}` };
  }
  return { schema, value };
}

const walked = (schema: z.ZodType): string[] => {
  const out: string[] = [];
  walkPrivacy(schema, { marked: (path, className) => out.push(`${path}:${className}`) });
  return out;
};

const truncated = (listed: PrivacyField[]) => listed.filter((field) => field.truncated);

describe("a chain of new schemas past the limit assumes every class where it is cut", () => {
  test("a class marked 300 levels down a factory is seen by classifyPrivacy, hasPrivacy and walkPrivacy", () => {
    const schema = factory(300);
    const listed = classifyPrivacy(schema);
    expect(hasPrivacy(schema, "pii")).toBe(true);
    expect(hasPrivacy(schema, "secret")).toBe(true);
    expect(listed.some((field) => field.class === "pii")).toBe(true);
    expect(walked(schema).some((entry) => entry.endsWith(":pii"))).toBe(true);
    // Every class is assumed at the cut, and only there: each such entry is truncated, and sits past the limit.
    expect(listed.length).toBeGreaterThan(0);
    for (const field of listed) {
      expect(field.truncated).toBe(true);
      expect(field.path.split(".").length).toBe(MAX_RECURSION_DEPTH + 1);
    }
    expect(new Set(listed.map((field) => field.class))).toEqual(new Set(unreadClasses()));
  });

  test("the class is listed found below the limit, and assumed from it on", () => {
    for (const depth of [200, MAX_RECURSION_DEPTH - 1]) {
      expect(classifyPrivacy(factory(depth)).map((field) => [field.class, field.truncated])).toEqual([
        ["pii", undefined],
      ]);
    }
    for (const depth of [MAX_RECURSION_DEPTH, MAX_RECURSION_DEPTH + 1, 2_000]) {
      expect(hasPrivacy(factory(depth), "pii")).toBe(true);
      expect(truncated(classifyPrivacy(factory(depth))).length).toBeGreaterThan(0);
    }
  });

  test("plain nesting deeper than the limit is cut alike: masked [truncated], every class assumed there", () => {
    const { schema, value } = nested(MAX_RECURSION_DEPTH);
    expect(hasPrivacy(schema, "pii")).toBe(true);
    const listed = classifyPrivacy(schema);
    const cut = [...Array(MAX_RECURSION_DEPTH).fill("a")].join(".");
    // The leaf's own mark was read, so it is found; every other class is assumed there, as past the budget.
    expect(listed).toContainEqual({ path: `${cut}.leaf`, class: "pii" });
    for (const className of unreadClasses()) {
      if (className !== "pii")
        expect(listed).toContainEqual({ path: `${cut}.leaf`, class: className, truncated: true });
      expect(listed).toContainEqual({ path: `${cut}.keep`, class: className, truncated: true });
    }
    expect(listed).toHaveLength(2 * unreadClasses().length);
    let leaf = redact(schema, schema.parse(value) as never) as Record<string, unknown>;
    for (let level = 0; level < MAX_RECURSION_DEPTH; level += 1) leaf = leaf.a as Record<string, unknown>;
    expect(leaf).toEqual({ leaf: "[truncated]", keep: "[truncated]" });
  });

  test("plain nesting under the limit is listed exactly", () => {
    const { schema } = nested(MAX_RECURSION_DEPTH - 1);
    const listed = classifyPrivacy(schema);
    expect(listed).toEqual([{ path: [...Array(MAX_RECURSION_DEPTH - 1).fill("a"), "leaf"].join("."), class: "pii" }]);
  });

  test("a search beneath an opaque node or a marked container that reaches the limit assumes every class", () => {
    const Row = z.object({ d: factory(300).transform((x) => x) });
    expect(classifyPrivacy(Row)).toEqual(
      unreadClasses().map((className) => ({ path: "d", class: className, truncated: true })),
    );
    expect(hasPrivacy(Row, "pii")).toBe(true);
    expect(redact(Row, { d: { id: "1" } } as never)).toEqual({ d: "[truncated]" });
    const Held = z.object({ h: secret(factory(300)) });
    expect(hasPrivacy(Held, "pii")).toBe(true);
    expect(classifyPrivacy(Held)).toContainEqual({ path: "h", class: "secret" });
    expect(classifyPrivacy(Held)).toContainEqual({ path: "h", class: "pii", truncated: true });
    expect(redact(Held, { h: { id: "1" } } as never)).toEqual({ h: "[secret]" });
  });

  test("a chain of new lazies at one position past the limit assumes every class", () => {
    const chain = (n: number): z.ZodType => (n === 0 ? pii(z.string()) : z.lazy(() => chain(n - 1)));
    const past = z.object({ v: chain(MAX_RECURSION_DEPTH + 44) });
    expect(hasPrivacy(past, "pii")).toBe(true);
    expect(classifyPrivacy(past)).toEqual(
      unreadClasses().map((className) => ({ path: "v", class: className, truncated: true })),
    );
    expect(redact(past, past.parse({ v: "P-1" }) as never)).toEqual({ v: "[truncated]" });
  });
});

describe("a recursion that repeats a position already read needs no cut in the list", () => {
  type Tree = { label: string; children: Tree[] };
  const Tree: z.ZodType<Tree> = z.object({
    label: pii(z.string()),
    get children() {
      return z.array(Tree);
    },
  }) as never;
  const Lazy: z.ZodType<Tree> = z.lazy(() => z.object({ label: pii(z.string()), children: z.array(Lazy) }));

  test("a tree and a linked list defined once are listed exactly, with no truncated entry", () => {
    expect(classifyPrivacy(Tree)).toEqual([{ path: "label", class: "pii" }]);
    expect(classifyPrivacy(Lazy)).toEqual([{ path: "label", class: "pii" }]);
    expect(classifyPrivacy(z.object({ t: Lazy.transform((x) => x) }))).toEqual([{ path: "t", class: "pii" }]);
    expect(classifyPrivacy(secret(Tree))).toEqual([
      { path: "", class: "secret" },
      { path: "", class: "pii" },
    ]);
    expect(hasPrivacy(Tree, "secret")).toBe(false);
  });

  test("a once-defined recursion met right at the limit adds no blanket entry", () => {
    // `Self` sits at the limit, so its field is one past it: the field's position is `Self` again, already read.
    const Self: z.ZodType = z.object({
      get self() {
        return Self.optional();
      },
    });
    let schema: z.ZodType = Self;
    for (let level = 0; level < MAX_RECURSION_DEPTH - 1; level += 1) schema = z.object({ a: schema });
    schema = z.object({ e: pii(z.string()), a: schema });
    expect(classifyPrivacy(schema)).toEqual([{ path: "e", class: "pii" }]);
    expect(hasPrivacy(schema, "secret")).toBe(false);
  });
});

describe("the list compares positions, the sets of schemas a value may hold, not schemas", () => {
  /** A ring of `length` objects, each built once, whose field `a` holds the next: the first marks `s` where `marked`. */
  function ring(length: number, marked: boolean): z.ZodType[] {
    const nodes: z.ZodType[] = [];
    for (let index = 0; index < length; index += 1) {
      const shape: Record<string, z.ZodType> = {};
      Object.defineProperty(shape, "a", { enumerable: true, get: () => nodes[(index + 1) % length] });
      if (marked && index === 0) shape.s = pii(z.string()).optional();
      nodes.push(z.object(shape).optional());
    }
    return nodes;
  }

  test("once-defined rings of co-prime lengths side by side meet no position twice, and are cut with every class", () => {
    // Three rings, 5, 7 and 11 long, side by side in one union: every schema is built once, but the set at each level
    // repeats only every 385 levels. No position repeats before the limit, so the list cuts there and assumes every
    // class: more than is marked, never less. One ring alone comes round to its own position and is listed exactly.
    const [five] = ring(5, true);
    const [seven] = ring(7, false);
    const [eleven] = ring(11, false);
    const Root = z.union([five, seven, eleven] as [z.ZodType, z.ZodType, z.ZodType]);
    const listed = classifyPrivacy(Root);
    const depthOf = (field: PrivacyField) => field.path.split(".").length;
    const found = listed.filter((field) => !field.truncated);
    expect(found.map((field) => field.class)).toEqual(found.map(() => "pii"));
    expect(found.map(depthOf).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 52 }, (_, index) => 1 + 5 * index),
    );
    expect(truncated(listed).map((field) => ({ class: field.class, depth: depthOf(field) }))).toEqual(
      unreadClasses().map((className) => ({ class: className, depth: MAX_RECURSION_DEPTH + 1 })),
    );
    expect(hasPrivacy(Root, "phi")).toBe(true);
    expect(classifyPrivacy(five as z.ZodType)).toEqual([{ path: "s", class: "pii" }]);
    expect(hasPrivacy(five as z.ZodType, "phi")).toBe(false);
  });
});
