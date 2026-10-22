// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { phi, pii } from "./classes";
import {
  classifyPrivacy,
  hasPrivacy,
  MAX_LISTED_PATHS,
  MAX_READ_SCHEMAS,
  privacyOf,
  unreadClasses,
  walkPrivacy,
} from "./classify";
import { redact } from "./redact";

/**
 * **Every bound the list keeps, and what it says where it stops** (#132). A list walks the schema, which can be far
 * larger than any value, so it has bounds. Each one ends a read without unbounded work, and each one says every class
 * may be there: the list never says less than the schema marks.
 */

/** One schema reused in two fields at every level, `levels` deep: `levels + 1` distinct objects, `2^levels` paths. */
function shared(levels: number): z.ZodType {
  let node: z.ZodType = z.object({ e: pii(z.string()) });
  for (let level = 0; level < levels; level += 1) node = z.object({ a: node.optional(), b: node.optional() });
  return z.object({ id: z.string(), t: node });
}

describe("a schema reused in many fields is listed in time and memory linear in its distinct schemas", () => {
  test("a reused schema with few paths lists every one of them, and no reference", () => {
    const listed = classifyPrivacy(shared(4));
    expect(listed).toHaveLength(2 ** 4);
    expect(listed).toContainEqual({ path: "t.b.a.b.a.e", class: "pii" });
    expect(listed.some((field) => field.sameAs !== undefined || field.truncated)).toBe(false);
  });

  test("thirty levels, a billion paths, list in well under a second and a few megabytes, every class kept", () => {
    const Deep = shared(30);
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    const listed = classifyPrivacy(Deep);
    const took = performance.now() - started;
    const grew = process.memoryUsage().heapUsed - heap;
    expect(took).toBeLessThan(1_000);
    expect(grew).toBeLessThan(64 * 1024 * 1024);
    expect(listed.length).toBeLessThan(MAX_LISTED_PATHS);
    expect(hasPrivacy(Deep, "pii")).toBe(true);
    expect(hasPrivacy(Deep, "phi")).toBe(false);
    expect(new Set(listed.map((field) => field.class))).toEqual(new Set(["pii"]));
    // Each path written out is a path redact masks. Past the cap, a position met again is listed by reference: its
    // path, every class beneath it, and the path it was first written out under.
    const references = listed.filter((field) => field.sameAs !== undefined);
    expect(references.length).toBeGreaterThan(0);
    const written = new Set(listed.filter((field) => field.sameAs === undefined).map((field) => field.path));
    for (const field of references) {
      expect(field.class).toBe("pii");
      expect(field.truncated).toBeUndefined();
      expect(field.sameAs?.startsWith("t.")).toBe(true);
      expect(field.path.startsWith("t.")).toBe(true);
      expect(written.has(field.path)).toBe(false);
    }
  });

  test("walkPrivacy reports a reference with the path it stands for", () => {
    const notes: string[] = [];
    walkPrivacy(shared(30), {
      marked: (path, className, note) => {
        if (note?.sameAs !== undefined) notes.push(`${path} ${className} ${note.sameAs}`);
      },
    });
    expect(notes.length).toBeGreaterThan(0);
  });
});

/** A getter tree that builds two new schemas at every level, `phi` marked `depth` levels down. */
function tree(depth: number, at = 0): z.ZodType {
  return z.object({
    get l() {
      return tree(depth, at + 1).optional();
    },
    get r() {
      return tree(depth, at + 1).optional();
    },
    ...(at === depth ? { x: phi(z.string()) } : {}),
  });
}

/** A lazy whose target is a union of two new lazies, `phi` marked `depth` lazies down. */
function lazies(depth: number, at = 0): z.ZodType {
  return z.lazy(() =>
    at === depth ? z.object({ x: phi(z.string()) }) : z.union([lazies(depth, at + 1), lazies(depth, at + 1)]),
  );
}

/** Every place a read can run out of its budget before it reaches a mark, and the path it is listed at. */
const cuts: [string, () => z.ZodType, string][] = [
  ["the search beneath a marked container", () => z.object({ id: z.string(), t: pii(tree(20)) }), "t"],
  ["the search beneath an opaque node", () => z.object({ id: z.string(), t: tree(20).transform((v) => v) }), "t"],
  ["the read of a position's lazies", () => z.object({ id: z.string(), t: lazies(15) }), "t"],
  [
    "the read of the shapes a choice can have",
    () => z.object({ id: z.string(), t: z.union([z.number(), lazies(15)]) }),
    "t",
  ],
  ["the walk's positions", () => z.object({ id: z.string(), t: tree(20) }), "t."],
];

describe("a read that runs out of its budget assumes every class it did not read", () => {
  test("the budget is the one every cut point in a call shares", () => {
    expect(MAX_READ_SCHEMAS).toBe(10_000);
  });

  test.each(cuts)("%s lists every class below it, and hasPrivacy sees each", (_, build, at) => {
    const schema = build();
    const listed = classifyPrivacy(schema);
    for (const name of unreadClasses()) {
      expect(hasPrivacy(schema, name)).toBe(true);
      expect(listed.some((field) => field.class === name && field.path.startsWith(at))).toBe(true);
    }
    // A class only assumed is flagged, never stated as found.
    const assumed = listed.filter((field) => field.class === "secret");
    for (const field of assumed) expect(field.truncated).toBe(true);
  });

  test("a class marked below the cut is never missing, and redact masks the value it may be in", () => {
    const Container = z.object({ id: z.string(), t: pii(tree(20)) });
    expect(classifyPrivacy(Container)).toContainEqual({ path: "t", class: "pii" });
    expect(classifyPrivacy(Container)).toContainEqual({ path: "t", class: "phi", truncated: true });
    // The placeholder is the strongest class found, never one only assumed, and the cutoff where none was found.
    expect(redact(Container, Container.parse({ id: "1", t: {} }) as never)).toEqual({ id: "1", t: "[pii]" });
    const Opaque = z.object({ id: z.string(), t: tree(20).transform((v) => v) });
    expect(redact(Opaque, Opaque.parse({ id: "1", t: {} }) as never)).toEqual({ id: "1", t: "[truncated]" });
    const Lazies = z.object({ id: z.string(), t: lazies(15) });
    expect(redact(Lazies, Lazies.parse({ id: "1", t: { x: "S-1" } }) as never)).toEqual({ id: "1", t: "[truncated]" });
  });
});

describe("a schema nested deeper than the stack is listed with every class, and nothing throws", () => {
  /** Twelve thousand nested intersections, as a union option parse never descends into. */
  function deep(): z.ZodType {
    let node: z.ZodType = z.object({ e: pii(z.string()) });
    for (let level = 0; level < 12_000; level += 1) node = z.intersection(node, z.object({}));
    return node;
  }

  test("classifyPrivacy, hasPrivacy and walkPrivacy list the position truncated with every class", () => {
    const Row = z.object({ id: z.string(), v: z.union([z.number(), deep()]) });
    expect(classifyPrivacy(Row)).toEqual(unreadClasses().map((name) => ({ path: "v", class: name, truncated: true })));
    expect(hasPrivacy(Row, "pii")).toBe(true);
    expect(hasPrivacy(Row, "phi")).toBe(true);
    const walked: string[] = [];
    expect(() => walkPrivacy(Row, { marked: (path, className) => walked.push(`${path} ${className}`) })).not.toThrow();
    expect(walked).toContain("v pii");
  });

  test("at the root too, and redact masks the whole value as [truncated]", () => {
    const Root = z.union([z.number(), deep()]);
    expect(classifyPrivacy(Root)).toEqual(unreadClasses().map((name) => ({ path: "", class: name, truncated: true })));
    expect(redact(Root, 1 as never)).toBe("[truncated]");
    const Row = z.object({ id: z.string(), v: z.union([z.number(), deep()]) });
    // What parse returns for it: the number option matches, and parse never descends into the other.
    expect(redact(Row, { id: "user-1", v: 1 } as never)).toBe("[truncated]");
  });
});

describe("a position read through choices that share a schema costs its distinct schemas, never its paths", () => {
  const readers: [string, (schema: z.ZodType, wire: unknown) => unknown][] = [
    ["redact", (schema, wire) => redact(schema, schema.parse(wire) as never)],
    ["classifyPrivacy", (schema) => classifyPrivacy(schema)],
    ["hasPrivacy", (schema) => hasPrivacy(schema, "pii")],
  ];

  /** Forty levels of a union, or an intersection, whose two sides wrap the one schema below: 2^40 paths to it. */
  function shared(base: z.ZodType, kind: "union" | "intersection"): z.ZodType {
    let node = base;
    for (let level = 0; level < 40; level += 1)
      node =
        kind === "union"
          ? z.union([node.optional(), node.nullable()])
          : z.intersection(node.optional(), node.nullable());
    return z.object({ id: z.string(), v: z.union([z.number(), z.lazy(() => node)]), e: pii(z.string()) });
  }

  /** A lazy that comes round to itself, under an intersection, so its every-shape answer ends no union early. */
  function cyclic(): z.ZodType {
    const loop: z.ZodType = z.lazy(() => z.union([z.string(), loop]));
    return z.intersection(loop, z.string());
  }

  const shapes: [string, () => z.ZodType][] = [
    ["a union", () => shared(z.object({ name: z.string() }), "union")],
    ["an intersection", () => shared(z.object({ name: z.string() }), "intersection")],
    ["a union over a lazy that meets itself", () => shared(cyclic(), "union")],
  ];

  for (const [shape, build] of shapes) {
    test.each(readers)(`${shape}: %s takes under 100 ms`, (_, run) => {
      const schema = build();
      const started = performance.now();
      run(schema, { id: "user-1", v: 7, e: "S-1" });
      expect(performance.now() - started).toBeLessThan(100);
    });
  }

  test("and the answer is the one the shape gives", () => {
    for (const [, build] of shapes) {
      const schema = build();
      expect(redact(schema, schema.parse({ id: "user-1", v: 7, e: "S-1" }) as never)).toEqual({
        id: "user-1",
        v: 7,
        e: "[pii]",
      });
      expect(classifyPrivacy(schema)).toEqual([{ path: "e", class: "pii" }]);
    }
  });
});

describe("a field cloned by .describe() or .meta() more times than Zod can read its metadata back through", () => {
  /** Fifty thousand clones: each one's metadata is read through its parent's, deeper than the stack can follow. */
  function described(how: "describe" | "meta"): z.ZodType {
    let note: z.ZodType = z.string();
    for (let index = 0; index < 50_000; index += 1)
      note = how === "describe" ? note.describe(`d${index}`) : note.meta({ n: index });
    return note;
  }

  test.each(["describe", "meta"] as const)("privacyOf never throws, and answers the strongest class (%s)", (how) => {
    const note = described(how);
    expect(() => privacyOf(note)).not.toThrow();
    expect(privacyOf(note)).toBe(unreadClasses()[0]);
  });

  test("classifyPrivacy lists it with every class, each truncated, and redact masks it", () => {
    const Row = z.object({ id: z.string(), email: pii(z.string()), note: described("describe") });
    const listed = classifyPrivacy(Row);
    expect(listed).toContainEqual({ path: "email", class: "pii" });
    for (const name of unreadClasses()) expect(listed).toContainEqual({ path: "note", class: name, truncated: true });
    expect(() => redact(Row, Row.parse({ id: "user-1", email: "S-1", note: "keep me" }) as never)).not.toThrow();
  });
});
