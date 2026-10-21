// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { sqliteJson } from "../data/codecs";
import type { Logger } from "../logger/logger";
import { pii } from "./classes";
import { redact } from "./redact";
import type { ContainsMarked } from "./types";

/**
 * **`Redacted<T>` tells the truth about every container** (#132).
 *
 * `bun run typecheck` holds each assertion: `same<A, B>()` compiles only when the two types are identical, so the
 * type `redact` returns is the shape it returns at runtime — an array stays an array, a tuple keeps its length, and
 * a map's or a set's masked keys and elements are plain strings, not branded ones. The runtime test beside them
 * checks the same shapes by value.
 */

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};

const Entry = z.object({ e: pii(z.string()), n: z.number() });

const List = z.object({ list: z.array(Entry), frozen: z.array(Entry).readonly() });
const Pair = z.object({ pair: z.tuple([pii(z.string()), z.number()]), rest: z.tuple([z.number()], pii(z.string())) });
const Keyed = z.object({ byEmail: z.map(pii(z.string()), Entry), emails: z.set(pii(z.string())) });
const Either = z.union([
  z.object({ k: z.literal("a"), list: z.array(Entry) }),
  z.object({ k: z.literal("b"), emails: z.set(pii(z.string())) }),
]);

const list = redact(List, { list: [], frozen: [] });
const pair = redact(Pair, Pair.parse({ pair: ["a@b.co", 1], rest: [1, "a@b.co"] }));
const keyed = redact(Keyed, Keyed.parse({ byEmail: new Map(), emails: new Set() }));
const either = redact(Either, { k: "a", list: [] });

same<typeof list, { list: { e: string; n: number }[]; frozen: readonly { e: string; n: number }[] }>();
same<typeof pair, { pair: [string, number]; rest: [number, ...string[]] }>();
same<typeof keyed, { byEmail: Map<string, { e: string; n: number }>; emails: Set<string> }>();
same<typeof either, { k: "a"; list: { e: string; n: number }[] } | { k: "b"; emails: Set<string> }>();
// A branded array is still an array: the brand goes, the elements map.
const branded = redact(
  z.object({ ids: z.array(z.string()).brand("Ids"), frozen: z.array(Entry).readonly().brand("F") }),
  {
    ids: [],
    frozen: [],
  } as never,
);
same<typeof branded, { ids: string[]; frozen: readonly { e: string; n: number }[] }>();

// Fail closed: a position any option marks is a masked string in every option.
const root = redact(z.union([pii(z.string()), z.number()]), 1);
same<typeof root, string>();
const field = redact(z.union([z.object({ e: pii(z.string()) }), z.object({ e: z.number(), k: z.literal(1) })]), {
  e: 1,
  k: 1,
});
same<typeof field, { e: string } | { e: string; k: 1 }>();
const nested = redact(
  z.union([
    z.object({ p: z.array(z.object({ e: pii(z.string()) })) }),
    z.object({ p: z.array(z.object({ e: z.number() })) }),
  ]),
  { p: [] },
);
same<typeof nested, { p: { e: string }[] } | { p: { e: string }[] }>();

// A transform over a marked input is masked whole, so its position is a string whatever the transform returns.
class Account {
  constructor(
    readonly email: string,
    readonly id: string,
  ) {}
}
const instance = redact(
  z.object({ e: pii(z.string()), id: z.string() }).transform((o) => new Account(o.e, o.id)),
  {} as never,
);
same<typeof instance, string>();
const copied = redact(z.array(z.object({ e: pii(z.string()) }).transform((o) => ({ ...o, f: o.e }))), []);
same<typeof copied, string[]>();
const renamed = redact(
  z.object({
    inner: z.object({ e: pii(z.string()) }).pipe(z.transform((o) => ({ f: o.e }))),
    n: z.number().optional(),
  }),
  {} as never,
);
same<typeof renamed, { inner: string; n?: number | undefined }>();
const unmarkedTransform = redact(
  z.object({ n: z.string() }).transform((o) => ({ m: o.n })),
  { m: "x" },
);
same<typeof unmarkedTransform, { m: string }>();
// A date where a branch with a mark inside reaches it is masked whole too.
const dated = redact(z.union([z.object({ e: pii(z.string()) }), z.date()]), new Date(0));
same<typeof dated, { e: string } | string>();
const keptDate = redact(z.object({ at: z.date(), e: pii(z.string()) }), { at: new Date(0) } as never);
same<typeof keptDate, { at: Date; e: string }>();

// A codec over a marked wire side is masked whole, so its position is a string whatever its app side says.
const wireCodec = redact(
  z.codec(z.object({ e: pii(z.string()) }), z.object({ e: z.number() }), {
    decode: (wire) => ({ e: wire.e.length }),
    encode: (app) => ({ e: String(app.e) as never }),
  }),
  { e: 1 },
);
same<typeof wireCodec, string>();
const wireField = redact(
  z.object({
    p: z.codec(pii(z.string()), z.number(), { decode: (wire) => wire.length, encode: (app) => String(app) as never }),
    n: z.number(),
  }),
  { p: 1, n: 1 },
);
same<typeof wireField, { p: string; n: number }>();
// A transform over a wire-marked codec carries the mark, though its input's output type has no brand.
const overWire = redact(
  z
    .object({ p: z.codec(pii(z.string()), z.string(), { decode: (wire) => wire, encode: (app) => app as never }) })
    .transform((o) => ({ q: o.p.length })),
  { q: 1 },
);
same<typeof overWire, string>();
// A plain pipe's input marks reach the position, as redact masks them.
const Marked = z.object({ n: pii(z.string()) });
const piped = redact(Marked.pipe(z.object({ n: z.coerce.number<z.output<typeof Marked>["n"]>() })), { n: 1 });
same<typeof piped, { n: string } | { n: string }>();
// A codec with an unmarked wire side is walked on its app side.
const appSide = redact(
  z.codec(z.string(), z.object({ e: pii(z.string()), n: z.number() }), {
    decode: (wire) => JSON.parse(wire),
    encode: (app) => JSON.stringify(app),
  }),
  {} as never,
);
same<typeof appSide, { e: string; n: number }>();
const column = redact(z.object({ profile: sqliteJson(z.object({ e: pii(z.string()), n: z.number() })) }), {} as never);
same<typeof column, { profile: { e: string; n: number } }>();
// A class instance where a branch with a mark inside reaches it is masked whole, so the member may be a string.
class Acct {
  constructor(readonly e: string) {}
}
const instanceOption = redact(z.union([z.object({ e: pii(z.string()) }), z.instanceof(Acct)]), new Acct("x"));
same<typeof instanceOption, { e: string } | string | { readonly e: string }>();
const unmarkedInstance = redact(z.object({ a: z.instanceof(Acct), e: pii(z.string()) }), {} as never);
same<typeof unmarkedInstance, { a: Acct; e: string }>();

same<ContainsMarked<typeof list>, false>();
same<ContainsMarked<typeof pair>, false>();
same<ContainsMarked<typeof either>, false>();
same<ContainsMarked<typeof keyed.byEmail extends Map<infer K, infer V> ? { key: K; value: V } : never>, false>();

/** Never run — the compiler checks the body. A redacted element is as loggable as the redacted whole. */
function compileOnly(log: Logger): void {
  log.info("first", { entry: list.list[0] });
  log.info("mapped", { emails: list.list.map((entry) => entry.e) });
  log.info("pair", { email: pair.pair[0] });
  for (const email of keyed.emails) log.info("set", { email });
  for (const [email, entry] of keyed.byEmail) log.info("map", { email, entry });
}

describe("Redacted<T>", () => {
  test("is the shape redact returns: arrays, tuples, maps and sets stay what they are", () => {
    const value = Keyed.parse({ byEmail: new Map([["a@b.co", { e: "a@b.co", n: 1 }]]), emails: new Set(["a@b.co"]) });
    const masked = redact(Keyed, value);
    expect(masked.byEmail).toBeInstanceOf(Map);
    expect([...masked.byEmail]).toEqual([["[pii]", { e: "[pii]", n: 1 }]]);
    expect([...masked.emails]).toEqual(["[pii]"]);
    const listed = redact(List, List.parse({ list: [{ e: "a@b.co", n: 1 }], frozen: [] }));
    expect(Array.isArray(listed.list)).toBe(true);
    expect(listed.list.map((entry) => entry.e)).toEqual(["[pii]"]);
    expect(pair).toEqual({ pair: ["[pii]", 1], rest: [1, "[pii]"] });
    expect(typeof compileOnly).toBe("function");
  });
});
