// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { phi, pii } from "./classes";
import {
  classifyPrivacy,
  hasPrivacy,
  MAX_LISTED_PATHS,
  MAX_SEARCHED_SCHEMAS,
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
  test("the budget is the one the cut points share", () => {
    expect(MAX_SEARCHED_SCHEMAS).toBe(10_000);
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
    expect(redact(Container, Container.parse({ id: "1", t: {} }) as never)).toEqual({ id: "1", t: "[secret]" });
    const Opaque = z.object({ id: z.string(), t: tree(20).transform((v) => v) });
    expect(redact(Opaque, Opaque.parse({ id: "1", t: {} }) as never)).toEqual({ id: "1", t: "[secret]" });
    const Lazies = z.object({ id: z.string(), t: lazies(15) });
    expect(redact(Lazies, Lazies.parse({ id: "1", t: { x: "S-1" } }) as never)).toEqual({ id: "1", t: "[secret]" });
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
