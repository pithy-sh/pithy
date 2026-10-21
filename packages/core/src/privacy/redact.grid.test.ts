// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { pii } from "./classes";
import { redact } from "./redact";

/**
 * **`redact` against `parse`, over a grid of shapes** (#132).
 *
 * Every shape below is built from a chain of up to three combinators over a marked leaf, and every object level
 * carries a marked field of its own, so a mark sits at every depth. `parse` is the oracle: whatever it keeps,
 * `redact` keeps, equal; whatever it drops, `redact` drops; and every value the grid put at a marked position —
 * each one the grid knows as marked — comes back as `[pii]`, as a value or as a key.
 *
 * An intersection's two sides name different unmarked fields at every depth (`n` on one, `m` on the other), and
 * the right side leaves the marks off, so a mask only one side knows has to survive the other.
 *
 * The grid runs once per marked leaf, and a leaf may carry its own type or refinement — `z.email()`, `z.uuid()`,
 * `z.number()`, a `.refine()` — at every marked position, with the same type unmarked on a side that leaves the marks
 * off. A placeholder fails each of them, so a walk that tested a union's option against a value it had already
 * masked would pick a looser option and let a field only the stricter one marks out raw. Two kinds put a union on
 * an intersection's right side to make that happen.
 */

/** A marked leaf's base schema, and the value the grid puts at a marked position of it. */
interface Leaf {
  readonly name: string;
  base(): z.ZodType;
  secret(tag: string): unknown;
  /** The key schema a record keyed by this leaf takes: a number is not a record key, so it keys by a string. */
  key(): z.ZodType;
  keySecret(tag: string): string;
}

const stringLeaf: Leaf = {
  name: "string",
  base: () => z.string(),
  secret: (tag) => `SECRET-${tag}`,
  key: () => z.string(),
  keySecret: (tag) => `SECRET-${tag}`,
};

/** A uuid the grid knows as marked, one per tag. */
const uuidOf = (tag: string): string =>
  `5ec2e700-0000-4000-8000-${[...tag]
    .map((char) => char.charCodeAt(0).toString(16))
    .join("")
    .padStart(12, "0")
    .slice(-12)}`;

const LEAVES: readonly Leaf[] = [
  stringLeaf,
  {
    name: "email",
    base: () => z.email(),
    secret: (tag) => `SECRET-${tag}@example.com`,
    key: () => z.email(),
    keySecret: (tag) => `SECRET-${tag}@example.com`,
  },
  { name: "uuid", base: () => z.uuid(), secret: uuidOf, key: () => z.uuid(), keySecret: uuidOf },
  {
    name: "number",
    base: () => z.number(),
    secret: (tag) => SECRET_NUMBER + tag.length,
    key: () => z.string(),
    keySecret: (tag) => `SECRET-${tag}`,
  },
  {
    name: "refine",
    base: () => z.string().refine((value) => value.startsWith("SECRET-")),
    secret: (tag) => `SECRET-${tag}`,
    key: () => z.string().refine((value) => value.startsWith("SECRET-")),
    keySecret: (tag) => `SECRET-${tag}`,
  },
];

/** The marked numbers sit in a band no unmarked number in the grid reaches. */
const SECRET_NUMBER = 424_200;

/** The leaf the grid is building with. Set per run, so the kinds below read it. */
let leaf: Leaf = stringLeaf;

/** Which unmarked fields an object level names, and whether this side marks. */
interface Side {
  readonly names: "nm" | "n" | "m";
  readonly mark: boolean;
}

const ALL: Side = { names: "nm", mark: true };

type Child = (side: Side) => z.ZodType;
type ChildValue = () => unknown;

interface Kind {
  readonly name: string;
  schema(child: Child, side: Side): z.ZodType;
  value(child: ChildValue): unknown;
}

/** The marked field, or its unmarked twin on a side that leaves the marks off. */
const markedString = (side: Side): z.ZodType => (side.mark ? pii(leaf.base()) : leaf.base());

/** A record key schema: the leaf's key schema, marked on a side that marks. */
const markedKey = (side: Side): z.ZodType => (side.mark ? pii(leaf.key()) : leaf.key());

/** The unmarked fields a side names. */
function named(side: Side): Record<string, z.ZodType> {
  return {
    ...(side.names.includes("n") ? { n: z.number() } : {}),
    ...(side.names.includes("m") ? { m: z.number() } : {}),
  };
}

const KINDS: readonly Kind[] = [
  {
    name: "object",
    schema: (child, side) => z.object({ a: child(side), s: markedString(side), ...named(side) }),
    value: (child) => ({ a: child(), s: leaf.secret("s"), n: 1, m: 2, x: "stripped" }),
  },
  {
    name: "strict",
    schema: (child, side) => z.strictObject({ a: child(side), s: markedString(side), n: z.number(), m: z.number() }),
    value: (child) => ({ a: child(), s: leaf.secret("s"), n: 1, m: 2 }),
  },
  {
    name: "loose",
    schema: (child, side) => z.looseObject({ a: child(side), s: markedString(side), ...named(side) }),
    value: (child) => ({ a: child(), s: leaf.secret("s"), n: 1, m: 2, x: "kept" }),
  },
  {
    name: "pick",
    schema: (child, side) =>
      z.object({ a: child(side), s: markedString(side), n: z.number(), m: z.number(), d: pii(z.string()) }).pick({
        a: true,
        s: true,
        ...(side.names.includes("n") ? { n: true as const } : {}),
        ...(side.names.includes("m") ? { m: true as const } : {}),
      }),
    value: (child) => ({ a: child(), s: leaf.secret("s"), n: 1, m: 2, d: leaf.secret("dropped") }),
  },
  {
    name: "omit",
    schema: (child, side) =>
      z.object({ a: child(side), s: markedString(side), n: z.number(), m: z.number(), d: pii(z.string()) }).omit({
        d: true,
        ...(side.names.includes("n") ? {} : { n: true }),
        ...(side.names.includes("m") ? {} : { m: true }),
      }),
    value: (child) => ({ a: child(), s: leaf.secret("s"), n: 1, m: 2, d: leaf.secret("dropped") }),
  },
  {
    name: "array",
    schema: (child, side) => z.array(child(side)),
    value: (child) => [child(), child()],
  },
  {
    name: "record",
    schema: (child, side) => z.record(z.string(), child(side)),
    value: (child) => ({ k: child(), j: child() }),
  },
  {
    name: "markedKeyRecord",
    schema: (child, side) => z.record(markedKey(side) as z.ZodString, child(side)),
    value: (child) => ({ [leaf.keySecret("k")]: child(), [leaf.keySecret("j")]: child() }),
  },
  {
    name: "tuple",
    schema: (child, side) => z.tuple([z.number(), child(side)]),
    value: (child) => [1, child()],
  },
  {
    name: "set",
    schema: (child, side) => z.set(child(side)),
    value: (child) => new Set([child()]),
  },
  {
    name: "map",
    schema: (child, side) => z.map(z.string(), child(side)),
    value: (child) => new Map([["k", child()]]),
  },
  {
    name: "optional",
    schema: (child, side) => child(side).optional(),
    value: (child) => child(),
  },
  {
    name: "nullable",
    schema: (child, side) => child(side).nullable(),
    value: (child) => child(),
  },
  {
    name: "lazy",
    schema: (child, side) => z.lazy(() => child(side)),
    value: (child) => child(),
  },
  {
    name: "intersection",
    schema: (child, side) => z.intersection(child({ names: "n", mark: side.mark }), child({ names: "m", mark: false })),
    value: (child) => child(),
  },
  {
    name: "union",
    schema: (child, side) => z.union([child({ names: "n", mark: side.mark }), child({ names: "m", mark: side.mark })]),
    value: (child) => child(),
  },
  {
    name: "intersectionOfUnion",
    schema: (child, side) =>
      z.intersection(
        child({ names: "n", mark: side.mark }),
        z.union([child({ names: "m", mark: false }), z.looseObject({})]),
      ),
    value: (child) => child(),
  },
  {
    // The left side marks `s`; the right side's strict option names `s` unmarked and marks what is below `a`.
    name: "unionAfterMask",
    schema: (child, side) =>
      z.intersection(
        z.object({ s: markedString(side) }),
        z.union([z.object({ a: child(side), s: markedString({ ...side, mark: false }) }), z.looseObject({})]),
      ),
    value: (child) => ({ a: child(), s: leaf.secret("s") }),
  },
  {
    name: "discriminatedUnion",
    schema: (child, side) =>
      z.discriminatedUnion("k", [
        z.object({
          k: z.literal("L"),
          a: child({ names: "n", mark: side.mark }),
          s: markedString(side),
          n: z.number(),
        }),
        z.object({
          k: z.literal("R"),
          a: child({ names: "m", mark: side.mark }),
          s: markedString(side),
          m: z.number(),
        }),
      ]),
    value: (child) => ({ k: "L", a: child(), s: leaf.secret("s"), n: 1, m: 2, x: "stripped" }),
  },
];

/** A chain of kinds, outermost first, over the marked leaf. */
function build(chain: readonly Kind[]): { schema: z.ZodType; value: () => unknown } {
  let schema: Child = (side) => markedString(side);
  let value: ChildValue = () => leaf.secret("leaf");
  for (const kind of [...chain].reverse()) {
    const inner = schema;
    const innerValue = value;
    schema = (side) => kind.schema(inner, side);
    value = () => kind.value(innerValue);
  }
  return { schema: schema(ALL), value };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

const isSecret = (value: unknown): boolean =>
  typeof value === "string"
    ? value.startsWith("SECRET-") || value.startsWith("5ec2e700-")
    : typeof value === "number" && value >= SECRET_NUMBER && value < SECRET_NUMBER + 100;
const MASKED_KEY = /^\[pii\]( #\d+)?$/;

/** Each difference between what parse kept and what redact returned, by path. */
function compare(parsed: unknown, redacted: unknown, path: string, out: string[]): void {
  if (isSecret(parsed)) {
    if (redacted !== "[pii]") out.push(`${path}: marked value came back as ${JSON.stringify(redacted)}`);
    return;
  }
  const entries = (left: [unknown, unknown][], right: [unknown, unknown][]): void => {
    if (left.length !== right.length) {
      out.push(`${path}: parse kept ${left.length} entries, redact ${right.length}`);
      return;
    }
    left.forEach(([key, item], index) => {
      const [redactedKey, redactedItem] = right[index] as [unknown, unknown];
      if (isSecret(key) ? !MASKED_KEY.test(String(redactedKey)) : redactedKey !== key)
        out.push(`${path}: key ${String(key)} came back as ${String(redactedKey)}`);
      compare(item, redactedItem, `${path}.${String(key)}`, out);
    });
  };
  if (isPlainObject(parsed)) {
    if (!isPlainObject(redacted)) out.push(`${path}: object came back as ${JSON.stringify(redacted)}`);
    else entries(Object.entries(parsed), Object.entries(redacted));
  } else if (Array.isArray(parsed)) {
    if (!Array.isArray(redacted)) out.push(`${path}: array came back as ${JSON.stringify(redacted)}`);
    else entries([...parsed.entries()], [...redacted.entries()]);
  } else if (parsed instanceof Set) {
    if (!(redacted instanceof Set)) out.push(`${path}: set came back as ${String(redacted)}`);
    else
      entries(
        [...parsed].map((item, index) => [index, item]),
        [...redacted].map((item, index) => [index, item]),
      );
  } else if (parsed instanceof Map) {
    if (!(redacted instanceof Map)) out.push(`${path}: map came back as ${String(redacted)}`);
    else entries([...parsed.entries()], [...redacted.entries()]);
  } else if (!Object.is(parsed, redacted)) {
    out.push(`${path}: ${JSON.stringify(parsed)} came back as ${JSON.stringify(redacted)}`);
  }
}

/** Every chain of one to `depth` kinds, outermost first. */
function chains(depth: number): Kind[][] {
  let level: Kind[][] = [[]];
  const all: Kind[][] = [];
  for (let length = 1; length <= depth; length += 1) {
    level = level.flatMap((chain) => KINDS.map((kind) => [...chain, kind]));
    all.push(...level);
  }
  return all;
}

/** What parse returns, or `undefined` when it refuses — Zod throws, rather than reports, an unmergeable intersection. */
function parseOrUndefined(schema: z.ZodType, value: unknown): { data: unknown } | undefined {
  try {
    const parsed = schema.safeParse(value);
    return parsed.success ? { data: parsed.data } : undefined;
  } catch {
    return undefined;
  }
}

describe("redact against parse", () => {
  test.each(LEAVES.map((each) => [each.name, each] as const))(
    "keeps what parse keeps, drops what parse drops, and masks every marked %s leaf, over every shape to depth 3",
    (_name, each) => {
      leaf = each;
      const failures: string[] = [];
      let compared = 0;
      let unparsed = 0;
      for (const chain of chains(3)) {
        const { schema, value } = build(chain);
        const parsed = parseOrUndefined(schema, value());
        if (!parsed) {
          unparsed += 1;
          continue;
        }
        compared += 1;
        const found: string[] = [];
        compare(parsed.data, redact(schema, value() as never), "$", found);
        if (found.length > 0)
          failures.push(`${chain.map((kind) => kind.name).join(" > ")}\n    ${found.join("\n    ")}`);
      }
      // The grid is only a check where parse succeeds; an intersection of two sets or maps cannot merge.
      expect(compared).toBeGreaterThan(unparsed * 4);
      expect(failures.slice(0, 20), `${failures.length} of ${compared} shapes differ`).toEqual([]);
    },
  );

  test.each<[string, z.ZodType, unknown]>([
    [
      "an array under an intersection",
      z.intersection(
        z.object({ list: z.array(z.object({ n: z.string() })) }),
        z.object({ list: z.array(z.object({ e: pii(z.string()) })) }),
      ),
      { list: [{ n: "n", e: "SECRET-e" }] },
    ],
    [
      "a record under an intersection",
      z.intersection(
        z.object({ r: z.record(z.string(), z.object({ n: z.string() })) }),
        z.object({ r: z.record(z.string(), z.object({ e: pii(z.string()) })) }),
      ),
      { r: { k: { n: "n", e: "SECRET-e" } } },
    ],
    [
      "a tuple under an intersection",
      z.intersection(
        z.object({ t: z.tuple([z.object({ n: z.string() })]) }),
        z.object({ t: z.tuple([z.object({ e: pii(z.string()) })]) }),
      ),
      { t: [{ n: "n", e: "SECRET-e" }] },
    ],
    [
      "an array under a union",
      z.union([
        z.object({ l: z.array(z.object({ x: z.string() })) }),
        z.object({ l: z.array(z.object({ y: z.string() })) }),
      ]),
      { l: [{ x: "1", y: "2" }] },
    ],
    [
      "a pick of a wider value",
      z.object({ id: z.string(), email: pii(z.string()) }).pick({ id: true }),
      { id: "u1", email: "SECRET-e" },
    ],
    [
      "a loose object's extra key",
      z.looseObject({ id: z.string(), email: pii(z.string()) }),
      { id: "u", email: "SECRET-e", extra: 1 },
    ],
    [
      "a top-level intersection",
      z.intersection(z.object({ id: z.string() }), z.object({ email: pii(z.string()) })),
      { id: "u", email: "SECRET-e", extra: 1 },
    ],
  ])("matches parse on %s", (_label, schema, value) => {
    const found: string[] = [];
    compare(schema.parse(value), redact(schema, value as never), "$", found);
    expect(found).toEqual([]);
  });
});
