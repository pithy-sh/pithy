// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { sqliteJson } from "../data/codecs";
import { pii } from "./classes";
import { classifyPrivacy } from "./classify";
import { redact } from "./redact";

/**
 * **`redact` against `parse` and `classifyPrivacy`, over a grid of shapes** (#132).
 *
 * Every shape below is a chain of up to three kinds over a marked leaf, and every object level carries a marked field
 * of its own, so a mark sits at every depth. The kinds are every node the rule names: each structural one — an object
 * stripped, strict and loose, a pick and an omit, an array, a record and one keyed by a marked value, a tuple, an
 * optional, a nullable, a lazy, the standard recursive lazy, an intersection, a union and a discriminated union — and
 * each opaque one — a transform, a pipe, a preprocess, a codec, `sqliteJson`, a `z.custom`, `any` and `unknown`, a
 * set, a map and a function. `redact` is handed `parse`'s data, as a caller hands it the app value, and three oracles
 * hold it to the rule:
 *
 * - **No raw marked value comes back**, as a value or as a key, anywhere — inside a class instance included.
 * - **Nothing `parse` kept is dropped**: every key, element and entry comes back, verbatim or masked, or the position
 *   holding it is masked whole.
 * - **`classifyPrivacy` agrees**: a position of what `redact` returns is masked exactly when `classifyPrivacy` lists a
 *   path naming it, over-masking included.
 *
 * `redact.types.test.ts` holds `Redacted<T>` to the same kinds at compile time.
 *
 * An intersection's two sides name different unmarked fields at every depth (`n` on one, `m` on the other), and the
 * right side leaves the marks off, so a mask only one side knows has to survive the other. The grid runs once per
 * marked leaf, and a leaf may carry its own type or refinement — `z.email()`, `z.uuid()`, `z.number()`, a `.refine()`.
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
    secret: (tag) => SECRET_NUMBER + ([...tag].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100),
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

/** A wire datetime decoded to a `Date`: a codec whose app value its wire side refuses. */
const isoDate = z.codec(z.iso.datetime(), z.date(), {
  decode: (wire: string) => new Date(wire),
  encode: (date: Date) => date.toISOString(),
});

/** What a transform kind hands back: a class instance, which no schema names the fields of. */
class Box {
  constructor(readonly held: unknown) {}
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
    value: (child) => new Set([child(), child()]),
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
  {
    // A codec in the option that marks: its wire side refuses the app value, so a test against it picks the looser one.
    name: "codecUnion",
    schema: (child, side) =>
      z.union([
        z.strictObject({ at: isoDate, a: child(side), s: markedString(side), n: z.number(), m: z.number() }),
        z.looseObject({}),
      ]),
    value: (child) => ({ at: "2026-01-01T00:00:00Z", a: child(), s: leaf.secret("s"), n: 1, m: 2 }),
  },
  {
    name: "transformField",
    schema: (child, side) =>
      z.object({
        a: child(side),
        s: markedString(side),
        t: z.string().transform((wire) => wire.length),
        ...named(side),
      }),
    value: (child) => ({ a: child(), s: leaf.secret("s"), t: "abc", n: 1, m: 2 }),
  },
  {
    // The input side marks; the output side names every field, unmarked, and keeps whatever is below `a`.
    name: "pipedObject",
    schema: (child, side) =>
      z
        .object({ a: child(side), s: markedString(side), ...named(side) })
        .pipe(z.object({ a: z.unknown(), s: z.unknown(), ...named(side) })),
    value: (child) => ({ a: child(), s: leaf.secret("s"), n: 1, m: 2 }),
  },
  {
    // A transform over a marked input: what it returns is opaque, so it is masked whole.
    name: "transformInstance",
    schema: (child, side) => z.object({ a: child(side), s: markedString(side) }).transform((input) => new Box(input)),
    value: (child) => ({ a: child(), s: leaf.secret("s") }),
  },
  {
    // A transform that renames: the marked value lands under a key no schema names.
    name: "transformRename",
    schema: (child, side) =>
      z.object({ a: child(side), s: markedString(side) }).transform((input) => ({ renamed: input.s, a: input.a })),
    value: (child) => ({ a: child(), s: leaf.secret("s") }),
  },
  {
    // A marked input piped into a chain that renames further along: the function is not at the output side's tail.
    name: "pipedTransform",
    schema: (child, side) =>
      z
        .object({ a: child(side), s: markedString(side) })
        .pipe(
          z
            .transform((input: { a: unknown; s: unknown }) => ({ moved: input.s, a: input.a }))
            .pipe(z.object({ moved: z.unknown(), a: z.unknown() })),
        ),
    value: (child) => ({ a: child(), s: leaf.secret("s") }),
  },
  {
    // One side marks `s`; the other leaves it unmarked and renames it in a transform, so the merged value holds a copy.
    name: "intersectionTransform",
    schema: (child, side) =>
      z.intersection(
        z.object({ a: child(side), s: markedString(side) }),
        z.object({ s: markedString({ ...side, mark: false }) }).transform((input) => ({ moved: input.s })),
      ),
    value: (child) => ({ a: child(), s: leaf.secret("s") }),
  },
  {
    name: "preprocess",
    schema: (child, side) => z.preprocess((value) => value, z.object({ a: child(side), s: markedString(side) })),
    value: (child) => ({ a: child(), s: leaf.secret("s") }),
  },
  {
    name: "codec",
    schema: (child, side) =>
      z.codec(z.string(), z.object({ a: child(side), s: markedString(side) }), {
        decode: (wire) => JSON.parse(wire),
        encode: (app) => JSON.stringify(app),
      }),
    value: (child) => JSON.stringify({ a: child(), s: leaf.secret("s") }),
  },
  {
    name: "sqliteJson",
    schema: (child, side) => z.object({ c: sqliteJson(z.object({ a: child(side), s: markedString(side) })) }),
    value: (child) => ({ c: { a: child(), s: leaf.secret("s") } }),
  },
  {
    name: "pipe",
    schema: (child, side) => z.unknown().pipe(z.object({ a: child(side), s: markedString(side) })),
    value: (child) => ({ a: child(), s: leaf.secret("s") }),
  },
  {
    // Opaque nodes with no mark inside, beside the marked ones: each is kept as it is.
    name: "unmarkedOpaque",
    schema: (child, side) =>
      z.object({
        a: child(side),
        s: markedString(side),
        u: z.unknown(),
        y: z.any(),
        c: z.custom<Box>((value) => value instanceof Box),
        f: z.function({ input: [z.string()], output: z.string() }),
      }),
    value: (child) => ({ a: child(), s: leaf.secret("s"), u: { kept: 1 }, y: [2], c: new Box(3), f: String }),
  },
  {
    // A function whose argument is marked holds a mark.
    name: "function",
    schema: (child, side) => z.object({ f: z.function({ input: [child(side)], output: z.string() }), n: z.number() }),
    value: () => ({ f: String, n: 1 }),
  },
  {
    // The standard recursive lazy: a node, and the next one.
    name: "recursive",
    schema: (child, side) => {
      const Node: z.ZodType = z.lazy(() => z.object({ a: child(side), s: markedString(side), next: Node.optional() }));
      return Node;
    },
    value: (child) => ({ a: child(), s: leaf.secret("s"), next: { a: child(), s: leaf.secret("t") } }),
  },
];

/** A chain of kinds, outermost first, over the marked leaf. Each leaf value is its own, so a set keeps both. */
function build(chain: readonly Kind[]): { schema: z.ZodType; value: () => unknown } {
  let schema: Child = (side) => markedString(side);
  let leaves = 0;
  let value: ChildValue = () => {
    leaves += 1;
    return leaf.secret(`leaf${leaves}`);
  };
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

const MASK = "[pii]";

/** A set's masked element, read as the mask: masked elements alike are numbered apart, `[pii] #2`, so none merge. */
const setElement = (item: unknown): unknown => (typeof item === "string" && MASKED_KEY.test(item) ? MASK : item);

/** `parent.key`, or `key` at the root: the join `classifyPrivacy` writes a path with. */
const join = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

/** Each place `parse` kept something that `redact` lost, left raw, or changed, by path. */
function compareToParse(parsed: unknown, redacted: unknown, path: string, out: string[]): void {
  if (isSecret(parsed)) {
    if (redacted !== MASK) out.push(`${path}: marked value came back as ${JSON.stringify(redacted)}`);
    return;
  }
  // Masking a whole position is over-masking, which the classify oracle checks; nothing below it is left to lose.
  if (redacted === MASK) return;
  const pairs = (left: [unknown, unknown][], right: [unknown, unknown][]): void => {
    if (right.length < left.length) {
      out.push(`${path}: parse kept ${left.length} entries, redact ${right.length}`);
      return;
    }
    left.forEach(([key, item], index) => {
      const [redactedKey, redactedItem] = right[index] as [unknown, unknown];
      if (isSecret(key) ? !MASKED_KEY.test(String(redactedKey)) : redactedKey !== key)
        out.push(`${path}: key ${String(key)} came back as ${String(redactedKey)}`);
      compareToParse(item, redactedItem, `${path}.${String(key)}`, out);
    });
  };
  if (isPlainObject(parsed)) {
    if (!isPlainObject(redacted)) {
      out.push(`${path}: object came back as ${JSON.stringify(redacted)}`);
      return;
    }
    // A key is found by name, or — a masked one — by its order among the masked keys, which both keep.
    const masked = Object.entries(redacted).filter(([key]) => MASKED_KEY.test(key));
    let nextMasked = 0;
    for (const [key, item] of Object.entries(parsed)) {
      if (isSecret(key)) {
        const found = masked[nextMasked++];
        if (!found) out.push(`${path}: key ${key} was lost`);
        else compareToParse(item, found[1], `${path}.${key}`, out);
      } else if (!Object.hasOwn(redacted, key)) out.push(`${path}: key ${key} was lost`);
      else compareToParse(item, redacted[key], `${path}.${key}`, out);
    }
  } else if (Array.isArray(parsed)) {
    if (!Array.isArray(redacted)) out.push(`${path}: array came back as ${JSON.stringify(redacted)}`);
    else pairs([...parsed.entries()], [...redacted.entries()]);
  } else if (parsed instanceof Set) {
    if (!(redacted instanceof Set)) out.push(`${path}: set came back as ${String(redacted)}`);
    else
      pairs(
        [...parsed].map((item, index) => [index, item]),
        [...redacted].map((item, index) => [index, setElement(item)]),
      );
  } else if (parsed instanceof Map) {
    if (!(redacted instanceof Map)) out.push(`${path}: map came back as ${String(redacted)}`);
    else pairs([...parsed.entries()], [...redacted.entries()]);
  } else if (typeof parsed === "function") {
    // Parse wraps a function in one of its own, so it is compared by kind, not by identity.
    if (typeof redacted !== "function") out.push(`${path}: function came back as ${String(redacted)}`);
  } else if (holdsSecret(parsed)) {
    out.push(`${path}: an opaque value holding a marked value came back as ${String(redacted)}`);
  } else if (!Object.is(parsed, redacted)) {
    out.push(`${path}: ${JSON.stringify(parsed)} came back as ${JSON.stringify(redacted)}`);
  }
}

/** Whether a value holds a marked value anywhere: in a field of a class instance, an element, a key. */
function holdsSecret(value: unknown, seen = new Set<unknown>()): boolean {
  if (isSecret(value)) return true;
  if (typeof value !== "object" || value === null || seen.has(value) || value instanceof Date) return false;
  seen.add(value);
  const entries: unknown[] =
    value instanceof Map ? [...value].flat() : value instanceof Set ? [...value] : Object.entries(value).flat();
  return entries.some((item) => holdsSecret(item, seen));
}

/**
 * Each position of what `redact` returned that is masked where `classifyPrivacy` lists no path naming it, or left
 * as it was where it lists one. `paths` is every way of spelling the position: an object key is its name or a
 * record's `*`, an array element `[]` or a tuple's `[i]`, a key `<key>`.
 */
function compareToClassify(redacted: unknown, paths: readonly string[], marked: ReadonlySet<string>, out: string[]) {
  const listed = paths.some((path) => marked.has(path));
  const where = paths[0] ?? "";
  if (redacted === MASK) {
    if (!listed) out.push(`${where || "$"}: masked, but classifyPrivacy lists none of ${paths.join(", ")}`);
    return;
  }
  if (listed) {
    out.push(`${where || "$"}: classifyPrivacy lists it, but it came back ${JSON.stringify(redacted)}`);
    return;
  }
  const under = (keys: (path: string) => string[]): string[] => [...new Set(paths.flatMap(keys))];
  const key = (name: unknown): void => {
    const keyPaths = under((path) => [join(path, "<key>")]);
    const keyListed = keyPaths.some((path) => marked.has(path));
    if (MASKED_KEY.test(String(name)) !== keyListed)
      out.push(`${keyPaths[0]}: key ${String(name)} disagrees with classifyPrivacy`);
  };
  if (isPlainObject(redacted)) {
    for (const [name, item] of Object.entries(redacted)) {
      key(name);
      // The recursive kind's next node is the position its parent is, and `classifyPrivacy` lists it there once.
      compareToClassify(
        item,
        [...under((path) => [join(path, name), join(path, "*")]), ...(name === "next" ? paths : [])],
        marked,
        out,
      );
    }
  } else if (Array.isArray(redacted)) {
    redacted.forEach((item, index) => {
      compareToClassify(
        item,
        under((path) => [`${path}[]`, `${path}[${index}]`]),
        marked,
        out,
      );
    });
  } else if (redacted instanceof Set) {
    for (const item of redacted)
      compareToClassify(
        setElement(item),
        under((path) => [`${path}[]`]),
        marked,
        out,
      );
  } else if (redacted instanceof Map) {
    for (const [name, item] of redacted) {
      key(name);
      compareToClassify(
        item,
        under((path) => [join(path, "*")]),
        marked,
        out,
      );
    }
  }
}

/**
 * Every difference between `redact` and its two oracles, for one shape and what `parse` returned for it. `redact` is
 * handed the app value, as a caller hands it one: the wire value would hide every transform and codec from the grid.
 */
function compare(schema: z.ZodType, parsed: unknown): string[] {
  const redacted = redact(schema, parsed as never);
  const found: string[] = [];
  compareToParse(parsed, redacted, "$", found);
  const marked = new Set(classifyPrivacy(schema).map((field) => field.path));
  compareToClassify(redacted, [""], marked, found);
  return found;
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
    "keeps what parse keeps, masks every marked %s leaf, and agrees with classifyPrivacy, over every shape to depth 3",
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
        const found = compare(schema, parsed.data);
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
  ])("agrees with parse and classifyPrivacy on %s", (_label, schema, value) => {
    expect(compare(schema, schema.parse(value))).toEqual([]);
  });
});
