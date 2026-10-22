// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "../data/codecs";
import { pii } from "./classes";
import { classifyPrivacy } from "./classify";
import { redact } from "./redact";
import type { Redacted } from "./types";

/**
 * **The redaction contract, held as a matrix** (#132).
 *
 * Every kind the contract names is a function from an inner schema to an outer one. Each is nested in each, three
 * deep, around one cell that holds a marked and an unmarked string and the kit's two scalar codecs, one of them
 * marked. For every combination, at runtime: every marked value is masked, every unmarked one comes back exactly as
 * `parse` returned it, nothing is dropped, and `classifyPrivacy` lists exactly the paths `redact` masked. At the
 * type level: `Redacted<T>` of each combination is exactly the output of the same combination built with every
 * marker taken off, which is the shape `redact` returns.
 *
 * Marked values are recognizable by value: a string starting `S-`, and a date at {@link MARKED_EPOCH}.
 */

/** The epoch the marked date in each cell holds, so a check can tell it from the unmarked one. */
const MARKED_EPOCH = 4_242_000;

/** A string the cell's marked key position holds: `S-` and a counter, so no two collide. */
let counter = 0;
const secretString = (): string => {
  counter += 1;
  return `S-${counter}`;
};
const plainString = (): string => {
  counter += 1;
  return `P-${counter}`;
};

/** The marker the marked build uses, and the one the unmarked twin uses in its place. */
const marked = <S extends z.ZodType>(schema: S) => pii(schema);
const unmarked = <S extends z.ZodType>(schema: S) => schema;

/** The cell, marked and unmarked: what every combination nests. */
const cell = () =>
  z.object({ m: pii(z.string()), u: z.string(), d: SQLiteDate, md: pii(SQLiteDate), b: SQLiteBoolean });
const twinCell = () => z.object({ m: z.string(), u: z.string(), d: SQLiteDate, md: z.string(), b: SQLiteBoolean });
const cellInput = (): unknown => ({ m: secretString(), u: plainString(), d: 1_000, md: MARKED_EPOCH, b: 1 });

/** Each kind, as a schema builder. `key` is a string schema for a key position, marked or not. */
const kinds = {
  object: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.object({ x: i, k: z.string() }),
  strict: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.strictObject({ x: i }),
  loose: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.looseObject({ x: i }),
  catchall: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.object({ k: z.string() }).catchall(i),
  pick: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) =>
    z.object({ x: i, y: z.string(), h: z.number() }).pick({ x: true, y: true }),
  omit: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) =>
    z.object({ x: i, y: z.string(), h: z.number() }).omit({ h: true }),
  partial: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.object({ x: i, y: z.string() }).partial(),
  extend: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.object({ k: z.string() }).extend({ x: i }),
  array: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.array(i),
  tuple: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.tuple([i, z.string()], i),
  record: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.record(z.string(), i),
  recordKey: <I extends z.ZodType, K extends z.core.$ZodRecordKey>(i: I, k: K) => z.record(k, i),
  symbolRecord: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.record(z.symbol(), i),
  map: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.map(z.string(), i),
  mapByValue: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.map(i, z.string()),
  mapKey: <I extends z.ZodType, K extends z.ZodType>(i: I, k: K) => z.map(k, i),
  set: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.set(i),
  setOfKeys: <I extends z.ZodType, K extends z.ZodType>(i: I, k: K) => z.object({ x: i, s: z.set(k) }),
  optional: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => i.optional(),
  nullable: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => i.nullable(),
  default: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) =>
    i.default(() => {
      throw new Error("The matrix always passes a value.");
    }),
  catch: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) =>
    i.catch(() => {
      throw new Error("The matrix always passes a valid value.");
    }),
  readonly: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => i.readonly(),
  brand: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => i.brand<"Matrix">(),
  union: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.union([i, z.number()]),
  // A marked string option beside the inner one: it masks a string, and the inner value, never one, is walked.
  option: <I extends z.ZodType, K extends z.ZodType>(i: I, k: K) => z.union([i, k]),
  discriminated: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) =>
    z.discriminatedUnion("t", [z.object({ t: z.literal("a"), v: i }), z.object({ t: z.literal("b"), w: z.string() })]),
  intersection: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) =>
    z.intersection(z.object({ x: i }), z.object({ y: z.string() })),
  json: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => sqliteJson(i),
  lazy: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) => z.lazy(() => i),
  getter: <I extends z.ZodType, K extends z.ZodType>(i: I, _k: K) =>
    z.object({
      get x() {
        return i;
      },
    }),
};

type Kind = keyof typeof kinds;
const KINDS = Object.keys(kinds) as Kind[];

/** What each kind puts in a value around its inner one, and the paths of the inner one's marked fields. */
interface Shell {
  input(inner: () => unknown): unknown;
  /** The outer paths, from the inner ones. Marked key positions are added here. */
  paths(inner: readonly string[]): string[];
}

/** Whether a value can be written as JSON and read back as itself: what a JSON column's input may be. */
function jsonSafe(value: unknown): boolean {
  if (value instanceof Map || value instanceof Set) return false;
  if (Array.isArray(value)) return value.every(jsonSafe);
  if (typeof value === "object" && value !== null) return Object.values(value).every(jsonSafe);
  return true;
}

const under = (prefix: string) => (inner: readonly string[]) =>
  inner.map((path) => (path === "" ? prefix : path.startsWith("[") ? `${prefix}${path}` : `${prefix}.${path}`));
const same = (inner: readonly string[]) => [...inner];
const keyed = (inner: readonly string[]) => ["<key>", ...under("*")(inner)];

const shells: Record<Kind, Shell> = {
  object: { input: (i) => ({ x: i(), k: plainString() }), paths: under("x") },
  strict: { input: (i) => ({ x: i() }), paths: under("x") },
  loose: { input: (i) => ({ x: i(), extra: plainString() }), paths: under("x") },
  catchall: { input: (i) => ({ k: plainString(), a: i(), b: i() }), paths: under("*") },
  pick: { input: (i) => ({ x: i(), y: plainString() }), paths: under("x") },
  omit: { input: (i) => ({ x: i(), y: plainString() }), paths: under("x") },
  partial: { input: (i) => ({ x: i(), y: plainString() }), paths: under("x") },
  extend: { input: (i) => ({ k: plainString(), x: i() }), paths: under("x") },
  array: { input: (i) => [i(), i()], paths: (inner) => inner.map((path) => join("[]", path)) },
  tuple: {
    input: (i) => [i(), plainString(), i(), i()],
    paths: (inner) => [...inner.map((path) => join("[0]", path)), ...inner.map((path) => join("[]", path))],
  },
  record: { input: (i) => ({ [plainString()]: i(), [plainString()]: i() }), paths: under("*") },
  recordKey: { input: (i) => ({ [secretString()]: i(), [secretString()]: i() }), paths: keyed },
  symbolRecord: { input: (i) => ({ [Symbol("a")]: i(), [Symbol("b")]: i() }), paths: under("*") },
  mapByValue: {
    input: (i) =>
      new Map([
        [i(), plainString()],
        [i(), plainString()],
      ]),
    paths: under("<key>"),
  },
  map: {
    input: (i) =>
      new Map([
        [plainString(), i()],
        [plainString(), i()],
      ]),
    paths: under("*"),
  },
  mapKey: {
    input: (i) =>
      new Map([
        [secretString(), i()],
        [secretString(), i()],
      ]),
    paths: keyed,
  },
  set: { input: (i) => new Set([i(), i()]), paths: (inner) => inner.map((path) => join("[]", path)) },
  setOfKeys: {
    input: (i) => ({ x: i(), s: new Set([secretString(), secretString()]) }),
    paths: (inner) => [...under("x")(inner), "s[]"],
  },
  optional: { input: (i) => i(), paths: same },
  nullable: { input: (i) => i(), paths: same },
  default: { input: (i) => i(), paths: same },
  catch: { input: (i) => i(), paths: same },
  readonly: { input: (i) => i(), paths: same },
  brand: { input: (i) => i(), paths: same },
  union: { input: (i) => i(), paths: same },
  option: { input: (i) => i(), paths: (inner) => ["", ...inner] },
  discriminated: { input: (i) => ({ t: "a", v: i() }), paths: under("v") },
  intersection: { input: (i) => ({ x: i(), y: plainString() }), paths: under("x") },
  json: {
    input: (i) => {
      const value = i();
      return jsonSafe(value) ? JSON.stringify(value) : value;
    },
    paths: same,
  },
  lazy: { input: (i) => i(), paths: same },
  getter: { input: (i) => ({ x: i() }), paths: under("x") },
};

/** `parent` then `path`, joined the way `classifyPrivacy` writes it. */
function join(parent: string, path: string): string {
  if (path === "") return parent;
  return path.startsWith("[") ? `${parent}${path}` : `${parent}.${path}`;
}

const CELL_PATHS = ["m", "md"];

/** One combination, outermost kind first: its schema, a fresh input for it, and the paths it marks. */
function build(chain: readonly Kind[]) {
  let schema: z.ZodType = cell();
  let input: () => unknown = cellInput;
  let paths: string[] = CELL_PATHS;
  for (const kind of [...chain].reverse()) {
    const inner = schema;
    const innerInput = input;
    const shell = shells[kind];
    schema = (kinds[kind] as (i: z.ZodType, k: z.ZodType) => z.ZodType)(inner, marked(z.string()));
    input = () => shell.input(innerInput);
    paths = shell.paths(paths);
  }
  return { schema, input, paths };
}

const isMarkedValue = (value: unknown): boolean =>
  (typeof value === "string" && value.startsWith("S-")) || (value instanceof Date && value.getTime() === MARKED_EPOCH);

/**
 * The difference between what `parse` returned and what `redact` returned, as a list of failures: a marked value that
 * was not masked, an unmarked one that changed, or a container that lost or gained an entry. Empty when it is exact.
 */
function compare(parsed: unknown, redacted: unknown, path: string, out: string[], keyed = false): void {
  if (isMarkedValue(parsed)) {
    // A key and a set element are numbered apart when they mask alike, so none is lost: `[pii]`, `[pii] #2`.
    const mask = keyed ? /^\[pii\]( #\d+)?$/ : /^\[pii\]$/;
    if (typeof redacted !== "string" || !mask.test(redacted))
      out.push(`${path}: marked ${String(parsed)} came back ${String(redacted)}`);
    return;
  }
  if (parsed instanceof Date) {
    if (!(redacted instanceof Date) || redacted.getTime() !== parsed.getTime()) out.push(`${path}: a date changed`);
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    if (!Object.is(parsed, redacted)) out.push(`${path}: ${String(parsed)} came back ${String(redacted)}`);
    return;
  }
  if (Array.isArray(parsed)) {
    if (!Array.isArray(redacted) || redacted.length !== parsed.length) {
      out.push(`${path}: an array of ${parsed.length} came back otherwise`);
      return;
    }
    for (const [index, item] of parsed.entries()) compare(item, redacted[index], `${path}[${index}]`, out);
    return;
  }
  if (parsed instanceof Map || parsed instanceof Set) {
    const kind = parsed instanceof Map ? Map : Set;
    if (!(redacted instanceof kind) || redacted.size !== parsed.size) {
      out.push(`${path}: a ${kind.name} of ${parsed.size} came back otherwise`);
      return;
    }
    const left = [...parsed.entries()];
    const right = [...(redacted as Map<unknown, unknown> | Set<unknown>).entries()];
    left.forEach(([key, item], index) => {
      const [rightKey, rightItem] = right[index] as [unknown, unknown];
      if (parsed instanceof Map) compare(key, rightKey, `${path}<${index}>`, out, true);
      compare(item, rightItem, `${path}{${index}}`, out, parsed instanceof Set);
    });
    return;
  }
  if (typeof redacted !== "object" || redacted === null) {
    out.push(`${path}: an object came back ${String(redacted)}`);
    return;
  }
  const left = Reflect.ownKeys(parsed);
  const right = Reflect.ownKeys(redacted);
  if (left.length !== right.length) {
    out.push(`${path}: ${left.length} keys came back ${right.length}`);
    return;
  }
  left.forEach((key, index) => {
    const rightKey = right[index] as PropertyKey;
    compare(key, rightKey, `${path}.<${String(key)}>`, out, true);
    compare(
      (parsed as Record<PropertyKey, unknown>)[key],
      (redacted as Record<PropertyKey, unknown>)[rightKey],
      `${path}.${String(key)}`,
      out,
    );
  });
}

/** One step of a path to a value: a name, an array index, a set element, a key, or a map's value. */
type Step = { name: string } | { index: number } | "element" | "key" | "value";

/**
 * Every position at which `redact` put a mask in place of a value `parse` returned, as the steps to it. It reads the
 * values alone, never the schema, so it is a check on `classifyPrivacy` that shares nothing with it.
 */
function maskedAt(parsed: unknown, redacted: unknown, at: readonly Step[], out: Step[][]): void {
  const isMask = (value: unknown): boolean => typeof value === "string" && /^\[[a-z_]+\]( #\d+)?$/.test(value);
  if (isMask(redacted) && !Object.is(parsed, redacted)) {
    out.push([...at]);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || parsed instanceof Date) return;
  if (typeof redacted !== "object" || redacted === null) return;
  if (Array.isArray(parsed)) {
    for (const [index, item] of parsed.entries())
      maskedAt(item, (redacted as unknown[])[index], [...at, { index }], out);
    return;
  }
  if (parsed instanceof Map || parsed instanceof Set) {
    const right = [...(redacted as Map<unknown, unknown> | Set<unknown>).entries()];
    [...parsed.entries()].forEach(([key, item], index) => {
      const [rightKey, rightItem] = (right[index] ?? []) as [unknown, unknown];
      if (parsed instanceof Set) maskedAt(item, rightItem, [...at, "element"], out);
      else {
        maskedAt(key, rightKey, [...at, "key"], out);
        maskedAt(item, rightItem, [...at, "value"], out);
      }
    });
    return;
  }
  const right = Reflect.ownKeys(redacted);
  Reflect.ownKeys(parsed).forEach((key, index) => {
    const rightKey = right[index] as PropertyKey;
    maskedAt(key, rightKey, [...at, "key"], out);
    maskedAt(
      (parsed as Record<PropertyKey, unknown>)[key],
      (redacted as Record<PropertyKey, unknown>)[rightKey],
      [...at, { name: String(key) }],
      out,
    );
  });
}

/**
 * Whether a path `classifyPrivacy` wrote names the steps to a value: `[]` any element of an array or a set, `[i]` that
 * index, `<key>` a key, `*` any name or a map's value, and any other segment that name.
 */
function names(path: string, steps: readonly Step[]): boolean {
  const segments = path.match(/\[\]|\[\d+\]|<key>|[^.[<]+/g) ?? [];
  return (
    segments.length === steps.length &&
    segments.every((segment, index) => {
      const step = steps[index] as Step;
      if (segment === "[]") return step === "element" || (typeof step === "object" && "index" in step);
      if (/^\[\d+\]$/.test(segment))
        return typeof step === "object" && "index" in step && `[${step.index}]` === segment;
      if (segment === "<key>") return step === "key";
      if (segment === "*") return step === "value" || (typeof step === "object" && "name" in step);
      return typeof step === "object" && "name" in step && step.name === segment;
    })
  );
}

/** Every combination of three kinds, outermost first. */
function* combinations(): Generator<Kind[]> {
  for (const a of KINDS) for (const b of KINDS) for (const c of KINDS) yield [a, b, c];
}

describe("the redaction contract, as a matrix of every supported kind nested in every other, three deep", () => {
  test(`masks every marked value, keeps every other as parse returned it, drops nothing, and lists what it masked`, () => {
    const failures: string[] = [];
    let ran = 0;
    for (const chain of combinations()) {
      const name = chain.join(" > ");
      const { schema, input, paths } = build(chain);
      let parsed: unknown;
      try {
        parsed = schema.parse(input());
      } catch (error) {
        failures.push(`${name}: the matrix built an input parse refuses: ${String(error).slice(0, 200)}`);
        continue;
      }
      ran += 1;
      const found: string[] = [];
      let redacted: unknown;
      try {
        redacted = redact(schema, parsed as never);
      } catch (error) {
        failures.push(`${name}: redact threw ${String(error)}`);
        continue;
      }
      compare(parsed, redacted, "", found);
      for (const each of found) failures.push(`${name}: ${each}`);
      const listed = classifyPrivacy(schema).map((field) => `${field.path} ${field.class}`);
      const expected = [...new Set(paths)].map((path) => `${path} pii`);
      if (JSON.stringify([...listed].sort()) !== JSON.stringify([...expected].sort()))
        failures.push(`${name}: classifyPrivacy listed ${listed.join(", ")}; expected ${expected.join(", ")}`);
    }
    expect(failures.slice(0, 20)).toEqual([]);
    expect(ran).toBe(KINDS.length ** 3);
  });
});

describe("classifyPrivacy, for the same matrix", () => {
  test("never omits a position redact masks: the list can say more, and never less", () => {
    const failures: string[] = [];
    let masks = 0;
    for (const chain of combinations()) {
      const { schema, input } = build(chain);
      const parsed = schema.parse(input());
      const at: Step[][] = [];
      maskedAt(parsed, redact(schema, parsed as never), [], at);
      masks += at.length;
      const listed = classifyPrivacy(schema).map((field) => field.path);
      for (const steps of at)
        if (!listed.some((path) => names(path, steps)))
          failures.push(`${chain.join(" > ")}: masked at ${JSON.stringify(steps)}, listed ${listed.join(", ")}`);
    }
    expect(failures.slice(0, 20)).toEqual([]);
    expect(masks).toBeGreaterThan(KINDS.length ** 3);
  });
});

// The type level: `Redacted<T>` of every combination is the output of its unmarked twin.

/** Each kind as a type: the schema its builder returns around `I`, with `K` at a key position. */
interface Applied<I extends z.ZodType, K extends z.ZodType & z.core.$ZodRecordKey> {
  object: ReturnType<typeof kinds.object<I, K>>;
  strict: ReturnType<typeof kinds.strict<I, K>>;
  loose: ReturnType<typeof kinds.loose<I, K>>;
  catchall: ReturnType<typeof kinds.catchall<I, K>>;
  pick: ReturnType<typeof kinds.pick<I, K>>;
  omit: ReturnType<typeof kinds.omit<I, K>>;
  partial: ReturnType<typeof kinds.partial<I, K>>;
  extend: ReturnType<typeof kinds.extend<I, K>>;
  array: ReturnType<typeof kinds.array<I, K>>;
  tuple: ReturnType<typeof kinds.tuple<I, K>>;
  record: ReturnType<typeof kinds.record<I, K>>;
  recordKey: ReturnType<typeof kinds.recordKey<I, K>>;
  symbolRecord: ReturnType<typeof kinds.symbolRecord<I, K>>;
  map: ReturnType<typeof kinds.map<I, K>>;
  mapByValue: ReturnType<typeof kinds.mapByValue<I, K>>;
  mapKey: ReturnType<typeof kinds.mapKey<I, K>>;
  set: ReturnType<typeof kinds.set<I, K>>;
  setOfKeys: ReturnType<typeof kinds.setOfKeys<I, K>>;
  optional: ReturnType<typeof kinds.optional<I, K>>;
  nullable: ReturnType<typeof kinds.nullable<I, K>>;
  default: ReturnType<typeof kinds.default<I, K>>;
  catch: ReturnType<typeof kinds.catch<I, K>>;
  readonly: ReturnType<typeof kinds.readonly<I, K>>;
  brand: ReturnType<typeof kinds.brand<I, K>>;
  union: ReturnType<typeof kinds.union<I, K>>;
  option: ReturnType<typeof kinds.option<I, K>>;
  discriminated: ReturnType<typeof kinds.discriminated<I, K>>;
  intersection: ReturnType<typeof kinds.intersection<I, K>>;
  json: ReturnType<typeof kinds.json<I, K>>;
  lazy: ReturnType<typeof kinds.lazy<I, K>>;
  // An instantiation expression does not reach into a getter's return type, so this one is written out.
  getter: z.ZodObject<{ readonly x: I }, z.core.$strip>;
}

type MarkedKey = ReturnType<typeof marked<z.ZodString>>;
type UnmarkedKey = ReturnType<typeof unmarked<z.ZodString>>;

type Chain<
  A extends Kind,
  B extends Kind,
  C extends Kind,
  I extends z.ZodType,
  K extends MarkedKey | UnmarkedKey,
> = Applied<Applied<Applied<I, K>[C], K>[B], K>[A];

type IsAny<T> = 0 extends 1 & T ? true : false;
/** Each assignable to the other, and neither `any`: the redacted type is the twin's output, no wider and no narrower. */
type Exact<A, B> =
  IsAny<A> extends true
    ? false
    : IsAny<B> extends true
      ? false
      : [A] extends [B]
        ? [B] extends [A]
          ? true
          : false
        : false;

type Check<A extends Kind, B extends Kind, C extends Kind> = Exact<
  Redacted<Chain<A, B, C, ReturnType<typeof cell>, MarkedKey>>,
  z.output<Chain<A, B, C, ReturnType<typeof twinCell>, UnmarkedKey>>
>;

/** Every combination under outer kind `A` whose type is not exact, as `[outer, middle, inner]`; `never` when none. */
type Inexact<A extends Kind> = {
  [B in Kind]: { [C in Kind]: Check<A, B, C> extends true ? never : [A, B, C] }[Kind];
}[Kind];

const exact = <T extends never>(..._proof: [T] extends [never] ? [] : [T]): void => {};

describe("Redacted<T>, for the same matrix", () => {
  test("is exactly the output of the combination built with no marker, for every combination", () => {
    // One line per outer kind: the compiler holds one set of 729 at a time.
    exact<Inexact<"object">>();
    exact<Inexact<"strict">>();
    exact<Inexact<"loose">>();
    exact<Inexact<"catchall">>();
    exact<Inexact<"pick">>();
    exact<Inexact<"omit">>();
    exact<Inexact<"partial">>();
    exact<Inexact<"extend">>();
    exact<Inexact<"array">>();
    exact<Inexact<"tuple">>();
    exact<Inexact<"record">>();
    exact<Inexact<"recordKey">>();
    exact<Inexact<"symbolRecord">>();
    exact<Inexact<"map">>();
    exact<Inexact<"mapByValue">>();
    exact<Inexact<"mapKey">>();
    exact<Inexact<"set">>();
    exact<Inexact<"setOfKeys">>();
    exact<Inexact<"optional">>();
    exact<Inexact<"nullable">>();
    exact<Inexact<"default">>();
    exact<Inexact<"catch">>();
    exact<Inexact<"readonly">>();
    exact<Inexact<"brand">>();
    exact<Inexact<"union">>();
    exact<Inexact<"option">>();
    exact<Inexact<"discriminated">>();
    exact<Inexact<"intersection">>();
    exact<Inexact<"json">>();
    exact<Inexact<"lazy">>();
    exact<Inexact<"getter">>();
    expect(KINDS).toHaveLength(Object.keys(kinds).length);
  });
});

// A kept value that reads like a placeholder: only a masked one is ever numbered.

/** Every order of `items`. */
function* orders<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (const [index, item] of items.entries()) {
    for (const rest of orders([...items.slice(0, index), ...items.slice(index + 1)])) yield [item, ...rest];
  }
}

describe("a set's elements and a map's keys, where a kept value equals a placeholder", () => {
  // Numbers are masked, strings kept: the kept strings are the placeholders a masked number would take.
  const Element = z.union([pii(z.number()), z.string()]);
  const containers: [string, z.ZodType, (items: unknown[]) => unknown, (out: unknown) => unknown[]][] = [
    ["set", z.set(Element), (items) => new Set(items), (out) => [...(out as Set<unknown>)]],
    [
      "map key",
      z.map(Element, z.number()),
      (items) => new Map(items.map((item, index) => [item, index])),
      (out) => [...(out as Map<unknown, number>).keys()],
    ],
    [
      "set in an object in an array",
      z.array(z.object({ s: z.set(Element) })),
      (items) => [{ s: new Set(items) }],
      (out) => [...((out as { s: Set<unknown> }[])[0] as { s: Set<unknown> }).s],
    ],
  ];

  test("keeps every kept value as it is and numbers each masked one apart from all of them, in every order", () => {
    const failures: string[] = [];
    let ran = 0;
    for (const [name, schema, make, read] of containers) {
      for (const order of orders<unknown>([1, 2, 3, "[pii]", "[pii] #2", "[pii] #4", "P-1"])) {
        ran += 1;
        const out = read(redact(schema, schema.parse(make(order)) as never));
        const label = `${name} ${JSON.stringify(order)}`;
        if (out.length !== order.length) failures.push(`${label}: ${out.length} came back`);
        order.forEach((item, index) => {
          const back = out[index];
          if (typeof item === "string" && back !== item) failures.push(`${label}: kept ${item} came back ${back}`);
          if (typeof item === "number" && (typeof back !== "string" || !/^\[pii\]( #\d+)?$/.test(back)))
            failures.push(`${label}: masked ${item} came back ${String(back)}`);
        });
        if (new Set(out).size !== out.length) failures.push(`${label}: two entries came back alike`);
      }
    }
    expect(failures.slice(0, 20)).toEqual([]);
    expect(ran).toBe(containers.length * 5_040);
  });
});
