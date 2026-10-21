// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { sqliteJson } from "../data/codecs";
import type { Logger } from "../logger/logger";
import { pii, secret } from "./classes";
import { redact } from "./redact";
import type { ContainsMarked, Redacted } from "./types";

/**
 * **`Redacted<T>` types exactly what `redact` returns, kind by kind** (#132).
 *
 * `bun run typecheck` holds each assertion: `same<A, B>()` compiles only when the two types are identical. There is one
 * per kind the rule names — every structural kind keeps its shape, every opaque kind with a mark inside is a `string`,
 * and every opaque kind with none keeps its output type — the kinds `redact.grid.test.ts` runs at runtime. The test
 * beside them checks a few of the same shapes by value.
 *
 * **Each position is either exactly what `redact` returns there, or `unknown`** — never a different concrete type.
 * It is `unknown` below a union or an intersection with a loose object, a catchall or an opaque option, past the
 * depth the type reads, and wherever the schema's type does not name its kind.
 */

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};

/** The value handed to each `redact` below: the compiler only reads the type it returns. */
const any = {} as never;

const E = pii(z.string());
const Entry = z.object({ e: E, n: z.number() });
type Entry = { e: string; n: number };
class Acct {
  constructor(readonly e: string) {}
}

// Structural kinds keep their shape, and a marked position is a string.
const object = redact(z.object({ e: E, n: z.number() }), any);
same<typeof object, Entry>();
const strict = redact(z.strictObject({ e: E, n: z.number() }), any);
same<typeof strict, Entry>();
const loose = redact(z.looseObject({ e: E, n: z.number() }), any);
same<typeof loose, { [x: string]: unknown; e: string; n: number }>();
// A key outside the shape is the catchall's, which the type does not follow: `unknown`.
const catchall = redact(z.object({ n: z.number() }).catchall(E), any);
same<typeof catchall, { [x: string]: unknown; n: number }>();
same<ContainsMarked<typeof catchall>, false>();
const pick = redact(Entry.pick({ e: true }), any);
same<typeof pick, { e: string }>();
const omit = redact(Entry.omit({ n: true }), any);
same<typeof omit, { e: string }>();
const array = redact(z.array(Entry), any);
same<typeof array, Entry[]>();
const record = redact(z.record(z.string(), E), any);
same<typeof record, Record<string, string>>();
const markedKey = redact(z.record(pii(z.string()), z.number()), any);
same<typeof markedKey, { [x: string]: number }>();
const tuple = redact(z.tuple([z.number(), E]), any);
same<typeof tuple, [number, string]>();
const rest = redact(z.tuple([z.number()], E), any);
same<typeof rest, [number, ...string[]]>();
const optional = redact(z.object({ o: E.optional(), p: Entry.optional() }), any);
same<typeof optional, { o?: string | undefined; p?: Entry | undefined }>();
const nullable = redact(z.object({ o: E.nullable(), p: Entry.nullable() }), any);
same<typeof nullable, { o: string | null; p: Entry | null }>();
const defaulted = redact(Entry.default({ e: E.parse("x"), n: 1 }), any);
same<typeof defaulted, Entry>();
const caught = redact(Entry.catch({ e: E.parse("x"), n: 1 }), any);
same<typeof caught, Entry>();
const frozen = redact(z.array(Entry).readonly(), any);
same<typeof frozen, readonly Entry[]>();
const branded = redact(z.object({ ids: z.array(z.string()).brand("Ids"), es: z.array(E).brand("Es") }), any);
same<typeof branded, { ids: string[]; es: string[] }>();
const lazy = redact(
  z.lazy(() => Entry),
  any,
);
same<typeof lazy, Entry>();
const intersection = redact(z.intersection(z.object({ e: E }), z.object({ n: z.number() })), any);
same<typeof intersection, { e: string } & { n: number }>();
// At a union every option's marks reach the position, so `e` is a string in every member.
const union = redact(z.union([z.object({ e: E }), z.object({ e: z.number(), k: z.literal(1) })]), any);
same<typeof union, { e: string } | { e: string; k: 1 }>();
const tagged = redact(
  z.discriminatedUnion("t", [z.object({ t: z.literal("a"), e: z.string() }), z.object({ t: z.literal("b"), e: E })]),
  any,
);
same<typeof tagged, { t: "a"; e: string } | { t: "b"; e: string }>();
const prim = redact(z.union([E, z.number()]), any);
same<typeof prim, string>();
// A recursive lazy annotated `z.ZodType<Node>` names no kind, so the type cannot see what redact walks: `unknown`.
type Node = { e: z.output<typeof E>; next?: Node };
const Node: z.ZodType<Node> = z.lazy(() => z.object({ e: E, next: Node.optional() }));
const recursive = redact(Node, any);
same<typeof recursive, unknown>();
const generic = redact(z.object({ n: z.string() as z.ZodType<string> }), any);
same<typeof generic, { n: unknown }>();
// One written with a getter is inferred, and keeps its shape.
const Tree = z.object({
  e: E,
  get kids() {
    return z.array(Tree);
  },
});
const tree = redact(Tree, any);
same<typeof tree.e, string>();
same<(typeof tree.kids)[number]["e"], string>();
// A schema typed `any` claims every shape; the type claims none.
// biome-ignore lint/suspicious/noExplicitAny: the case under test.
const untyped = redact(z.object({ a: z.string() }) as any, any);
same<typeof untyped, unknown>();

// Every opaque kind with a mark inside is masked whole, so it is a string.
const transform = redact(
  Entry.transform((o) => new Acct(o.e)),
  any,
);
same<typeof transform, string>();
const pipe = redact(z.object({ e: z.string() }).pipe(z.object({ e: E })), any);
same<typeof pipe, string>();
const preprocess = redact(
  z.preprocess((v) => v, Entry),
  any,
);
same<typeof preprocess, string>();
const codec = redact(
  z.codec(z.string(), Entry, { decode: (s) => JSON.parse(s), encode: (o) => JSON.stringify(o) }),
  any,
);
same<typeof codec, string>();
const column = redact(z.object({ profile: sqliteJson(Entry), id: z.string() }), any);
same<typeof column, { profile: string; id: string }>();
const set = redact(z.set(E), any);
same<typeof set, string>();
const map = redact(z.map(z.string(), Entry), any);
same<typeof map, string>();
const fn = redact(z.object({ f: z.function({ input: [E], output: z.string() }) }), any);
same<typeof fn, { f: string }>();
const promise = redact(z.promise(E), any);
same<typeof promise, string>();
const optionalTransform = redact(z.object({ t: Entry.transform((o) => o.n).optional() }), any);
same<typeof optionalTransform, { t?: string | undefined }>();
// An opaque node with no mark inside beside a mark reads the same value, so the position is masked whole too.
const beside = redact(z.union([Entry, z.unknown()]), any);
same<typeof beside, string>();
const besideTransform = redact(z.union([Entry, z.object({ e: z.string() }).transform((o) => ({ m: o.e }))]), any);
same<typeof besideTransform, string>();
const strongest = redact(
  z.object({ e: E, t: secret(z.string()) }).transform((o) => o),
  any,
);
same<typeof strongest, string>();

// Every opaque kind with no mark inside keeps its output type.
const plainTransform = redact(
  z.object({ n: z.string() }).transform((o) => ({ m: o.n })),
  any,
);
same<typeof plainTransform, { m: string }>();
const plainOpaque = redact(
  z.object({
    u: z.unknown(),
    c: z.instanceof(Acct),
    s: z.set(z.string()),
    m: z.map(z.string(), z.number()),
    j: sqliteJson(z.object({ theme: z.string() })),
    d: z.date(),
  }),
  any,
);
same<
  typeof plainOpaque,
  { u: unknown; c: Acct; s: Set<string>; m: Map<string, number>; j: { theme: string }; d: Date }
>();
// A scalar holds nothing else, so a date beside a marked object is kept; below that union the type claims nothing.
const dated = redact(z.union([z.object({ e: E }), z.date()]), any);
same<typeof dated, { e: unknown } | Date>();
// A check is not in the type, as it is not in the rule: a refine keeps the object it refines.
const refined = redact(
  Entry.refine(() => true),
  any,
);
same<typeof refined, Entry>();

// A coercion runs over the whole input a structural option beside it reads, so it is not a scalar: masked whole.
const coerced = redact(z.object({ tags: z.union([z.array(E).max(1), z.coerce.string()]) }), any);
same<typeof coerced, { tags: string }>();
const coercedDate = redact(z.union([z.array(E).length(2), z.coerce.date()]), any);
same<typeof coercedDate, string>();
const plainScalar = redact(z.object({ tags: z.union([z.array(E), z.string()]) }), any);
same<typeof plainScalar, { tags: unknown[] | string }>();

// A mark seven levels inside an opaque node still masks it whole, as redact does.
const d7 = z.object({
  a: z.object({ b: z.object({ c: z.object({ d: z.object({ f: z.object({ g: z.object({ e: E }) }) }) }) }) }),
});
const deepColumn = redact(z.object({ p: sqliteJson(d7) }), any);
same<typeof deepColumn, { p: string }>();
// And a position seven levels down is still read by the rule: a transform or an unknown beside a mark is a string.
type Deep<T> = { a: { b: { c: { d: { f: { g: { t: T } } } } } } };
const deep = <S extends z.ZodType>(t: S) =>
  z.object({ a: z.object({ b: z.object({ c: z.object({ d: z.object({ f: z.object({ g: z.object({ t }) }) }) }) }) }) });
const deepTransform = redact(deep(z.object({ e: E }).transform((v) => v)), any);
same<typeof deepTransform, Deep<string>>();
const deepUnknown = redact(deep(z.union([z.object({ e: E }), z.unknown()])), any);
same<typeof deepUnknown, Deep<string>>();
const deepKept = redact(deep(z.object({ e: E, n: z.number() })), any);
same<typeof deepKept, Deep<{ e: string; n: number }>>();
// Fifteen levels down is still read.
const d15 = redact(deep(deep(z.object({ e: E }))), any);
same<typeof d15.a.b.c.d.f.g.t.a.b.c.d.f.g.t.e, string>();

// Below a union or an intersection with a loose object, a catchall or an opaque option, every position is `unknown`:
// a key the other option names may reach the catchall at runtime, which masks it.
const u8 = redact(
  z.union([z.object({ a: z.object({ x: z.string() }) }), z.object({}).catchall(pii(z.object({ x: z.string() })))]),
  any,
);
same<typeof u8, { a: unknown } | { [x: string]: unknown }>();
const i4 = redact(z.intersection(z.looseObject({}), z.object({ a: z.object({ x: z.string(), e: E }) })), any);
same<typeof i4, { [x: string]: unknown } & { a: unknown }>();
const u9 = redact(z.union([z.looseObject({}), z.object({ a: z.object({ x: z.string(), e: E }) })]), any);
same<typeof u9, { [x: string]: unknown } | { a: unknown }>();
// A union of plain objects reads every option precisely: the shapes above.
const plainUnion = redact(z.union([z.object({ a: z.object({ e: E }) }), z.object({ b: z.number() })]), any);
same<typeof plainUnion, { a: { e: string } } | { b: number }>();

// Past the depth the type reads, a position is `unknown`, never the brand-based guess: redact masks this one whole.
type Chain<T, N extends unknown[] = []> = N["length"] extends 18 ? T : { n: Chain<T, [...N, 0]> };
type Level16<T> = T extends { n: { n: { n: { n: { n: { n: { n: { n: infer R } } } } } } } }
  ? R extends { n: { n: { n: { n: { n: { n: { n: { n: infer Q } } } } } } } }
    ? Q
    : never
  : never;
const wrap = <S extends z.ZodType>(inner: S) => z.object({ n: inner });
const d0 = z.object({ e: E }).transform((o) => ({ c: o.e as string }));
const d6 = wrap(wrap(wrap(wrap(wrap(wrap(d0))))));
const d18 = wrap(wrap(wrap(wrap(wrap(wrap(wrap(wrap(wrap(wrap(wrap(wrap(d6))))))))))));
const deep18 = redact(d18, any);
same<Level16<typeof deep18>["n"], unknown>();
same<Level16<typeof deep18>, { n: unknown }>();
// An opaque node whose insides run past the depth the type searches is `unknown`, marked or not.
const deepPlain = redact(z.object({ p: sqliteJson(deep(deep(deep(z.object({ x: z.string() }))))) }), any);
same<typeof deepPlain, { p: unknown }>();
// The value-level type is bounded the same way.
same<Level16<Redacted<Chain<{ e: z.output<typeof E> }>>>["n"], unknown>();

// A recursive schema inside a codec is searched until the depth runs out: a marked one is a string, as redact masks
// it, and an unmarked one is `unknown`, because the type cannot tell it from one marked deeper than it reads.
const Cat = z.object({
  label: z.string(),
  get children() {
    return z.array(Cat);
  },
});
const MarkedCat = z.object({
  label: E,
  get children() {
    return z.array(MarkedCat);
  },
});
const cats = redact(z.object({ j: sqliteJson(Cat), k: sqliteJson(MarkedCat) }), any);
same<typeof cats, { j: unknown; k: string }>();
// Two nested instances of one generic schema are told apart, so a mark fifteen levels inside a codec is still found.
const twice = redact(z.object({ p: sqliteJson(deep(deep(z.object({ e: E })))) }), any);
same<typeof twice, { p: string }>();

// The type of a value already redacted, read off its own type.
same<
  Redacted<{ e: z.output<typeof E>; n: number; tags: z.output<typeof E>[] }>,
  { e: string; n: number; tags: string[] }
>();
same<Redacted<Map<string, z.output<typeof E>>>, string>();
same<Redacted<{ at: Date; m: Map<string, number> }>, { at: Date; m: Map<string, number> }>();

same<ContainsMarked<typeof array>, false>();
same<ContainsMarked<typeof tuple>, false>();
same<ContainsMarked<typeof union>, false>();
same<ContainsMarked<typeof tree>, false>();

/** Never run — the compiler checks the body. A redacted element is as loggable as the redacted whole. */
function compileOnly(log: Logger): void {
  log.info("first", { entry: array[0] });
  log.info("mapped", { emails: array.map((entry) => entry.e) });
  log.info("pair", { email: tuple[1] });
  log.info("column", { profile: column.profile });
  log.info("tree", { node: tree });
}

describe("Redacted<T>", () => {
  test("is the shape redact returns: structural kinds keep theirs, opaque ones with a mark inside are strings", () => {
    const List = z.object({ list: z.array(Entry), pair: z.tuple([z.number(), E]), emails: z.set(E) });
    const value = List.parse({ list: [{ e: "a@b.co", n: 1 }], pair: [1, "a@b.co"], emails: new Set(["a@b.co"]) });
    const masked = redact(List, value);
    expect(masked).toEqual({ list: [{ e: "[pii]", n: 1 }], pair: [1, "[pii]"], emails: "[pii]" });
    expect(Array.isArray(masked.list)).toBe(true);
    expect(typeof masked.emails).toBe("string");
    expect(typeof compileOnly).toBe("function");
  });
});
