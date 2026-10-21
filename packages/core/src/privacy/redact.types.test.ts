// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
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
