// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import { MessageKey } from "@pithy-sh/core/src/i18n/catalog";
import { describe, expect, test } from "vitest";
import { esErrors } from "./errors";

/**
 * The Spanish error catalog against the taxonomy it answers to.
 *
 * **The code set is derived from `KitErrorPayload.options` at runtime, never copied.** A hand-written
 * list here would be a second enumeration of the taxonomy, and the failure mode of a second
 * enumeration is that it stays green: a capability lands five codes, nobody translates them, and the
 * only file that knew is the one that was not edited. Reading the union means a code cannot exist
 * without this test knowing its name.
 *
 * Both directions matter. A missing entry is a caller reading English in a Spanish app; an extra entry
 * is a sentence for a code nothing throws — a typo that renders as nothing, forever, because the
 * lookup that would have found it never runs.
 */

/**
 * Every kit error code, in union order.
 *
 * `member.shape.code.value` is how the taxonomy reads itself in `payload.ts` and in `client.test.ts`,
 * so this is the same access, not a new one.
 */
const CODES = KitErrorPayload.options.map((member) => member.shape.code.value);

/** Each code's English summary, for the check that no Spanish entry is still its English. */
const ENGLISH = new Map<string, string>(
  KitErrorPayload.options.map((member) => [member.shape.code.value, member.description ?? ""]),
);

/**
 * The size of the taxonomy, pinned.
 *
 * A duplicate of `KIT_ERROR_CODE_COUNT` in `core`'s `payload.test.ts`, and deliberately not imported
 * from it — one package's tests are not the other's public surface. The number earns the duplication
 * because without it every assertion below is a comparison of two sets that could both be empty: a
 * catalog gutted to `{}` and a union that failed to import would agree with each other perfectly. The
 * population is what makes the agreement mean something.
 *
 * **The four sites, so one red gate names them all.** This number is written by hand in four places on
 * purpose (see above). Adding or removing a kit error code moves every one of them, and they live in
 * three packages that do not run each other's tests — so a contributor who fixes only the one that went
 * red ships the other three red. They are:
 *
 *   packages/core/src/error/payload.test.ts            KIT_ERROR_CODE_COUNT
 *   packages/cli/src/ci/catalogCoverage.test.ts        KIT_ERROR_CODE_COUNT
 *   packages/i18n/src/catalogs/es/errors.test.ts       KIT_ERROR_CODE_COUNT
 *   packages/i18n/src/catalogs/es/catalogs.test.ts     the inline toHaveLength
 *
 * And the code itself also needs: the Spanish sentence in `packages/i18n/src/catalogs/es/errors.ts`,
 * and `bun run docs-catalog` to regenerate `docs/catalog.generated.json`.
 */
const KIT_ERROR_CODE_COUNT = 122;

/**
 * The code that forced the grammar wide enough to spell the taxonomy.
 *
 * `MessageKey`'s domain segment was `[a-z][a-z0-9]*` while its tail admitted `_`, so this — a kit error
 * code since long before the catalog grammar existed, and one of the codes a caller meets most — was a
 * valid error code and an invalid catalog key. `core` widened the domain to match its own tail (#441),
 * which is what turns the assertions below from a subset with an exception written under it into the
 * plain property: **every** kit code is spellable as a key. Named rather than left implicit, because an
 * `_` back out of that regex would otherwise fail with a list of codes and no account of why they matter.
 */
const WIDENED_THE_DOMAIN = "rate_limit/exceeded";

/**
 * English words that are not also Spanish words.
 *
 * The check this list serves is "no entry is still its English", and the honest statement of what it
 * can do is: it catches a sentence left in English, not a bad translation. Every word here was checked
 * against Spanish before it went in, and the near misses are the point — `has` is second-person
 * `haber` and is in two entries below, `es`, `no`, `de`, `que` and `son` are all Spanish, and any of
 * them in this list would fail the catalog for being correct. So the list is short and each member is
 * unambiguous.
 */
const ENGLISH_ONLY = [
  "the",
  "this",
  "that",
  "does",
  "not",
  "could",
  "with",
  "from",
  "was",
  "were",
  "are",
  "have",
  "and",
  "for",
  "you",
  "your",
  "its",
  "requested",
  "failed",
  "exist",
];
const ENGLISH_WORD = new RegExp(`\\b(?:${ENGLISH_ONLY.join("|")})\\b`, "i");

/** `{placeholder}`, spelled exactly as `interpolate` spells it. */
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

describe("the Spanish error catalog covers the taxonomy", () => {
  test("the taxonomy is the size it is pinned at, so the comparisons below are not two empty sets", () => {
    expect(CODES).toHaveLength(KIT_ERROR_CODE_COUNT);
    expect(new Set(CODES).size).toBe(KIT_ERROR_CODE_COUNT);
  });

  test("every kit error code has a Spanish entry", () => {
    const missing = CODES.filter((code) => esErrors[code] === undefined);
    expect(missing).toEqual([]);
    expect(Object.keys(esErrors)).toHaveLength(KIT_ERROR_CODE_COUNT);
  });

  test("no entry exists for a code the kit does not throw", () => {
    const codes = new Set<string>(CODES);
    expect(Object.keys(esErrors).filter((key) => !codes.has(key))).toEqual([]);
  });
});

describe("every key is a catalog key", () => {
  test("every kit error code is spellable as a `MessageKey`", () => {
    // For an error the key *is* the code, so a code the grammar refuses is a code no locale can name and
    // no adopter can override. `rate_limit/exceeded` is asserted by name as well: it is the code the
    // grammar was widened for, so a domain segment narrowed back to `[a-z][a-z0-9]*` fails here saying so.
    expect(CODES).toContain(WIDENED_THE_DOMAIN);
    expect(CODES.filter((code) => !MessageKey.safeParse(code).success)).toEqual([]);
  });

  test("every key this catalog states, the grammar spells", () => {
    expect(Object.keys(esErrors).filter((key) => !MessageKey.safeParse(key).success)).toEqual([]);
  });
});

describe("every entry is Spanish a caller can read", () => {
  test("no entry is blank", () => {
    expect(Object.entries(esErrors).filter(([, message]) => message.trim() === "")).toEqual([]);
  });

  test("no entry is still its English", () => {
    const english = Object.entries(esErrors).filter(
      ([key, message]) => message === ENGLISH.get(key) || ENGLISH_WORD.test(message),
    );
    expect(english).toEqual([]);
  });

  test("every entry ends on a period, because the period is the brand", () => {
    const unpunctuated = Object.entries(esErrors).filter(([, message]) => !message.endsWith("."));
    expect(unpunctuated).toEqual([]);
    expect(Object.entries(esErrors).filter(([, message]) => message.includes("!"))).toEqual([]);
  });
});

/**
 * The placeholder invariant, and why it is written the only way it can be checked soundly.
 *
 * The obvious invariant — every `{placeholder}` in a Spanish entry also appears in the English one —
 * has nothing to check against. There is no English catalog: a payload carries its English `message`
 * from the throw site, and a throw site is a call, not a declaration, so no static set of placeholder
 * names for a code exists anywhere in this repository to compare with. `params` is typed as an open
 * `Record<string, string | number | boolean>` precisely so a throw site can name what it likes.
 *
 * What *is* checkable is the fact that makes the question moot today: **no throw site in this
 * repository passes `params` at all.** So any placeholder written here would render literally — the
 * documented behavior of `interpolate`, which leaves an unsupplied placeholder as written rather than
 * blanking it — and `Sala {code} llena.` is a worse sentence than the generic one it replaced. The
 * sound gate is therefore that the catalog names no placeholder, and it fails the moment somebody
 * invents one ahead of the value that fills it.
 *
 * The day a throw site does pass `params`, this test is what has to change, and the change is not a
 * loosening: the pin becomes "every placeholder here is one that some throw site passes for this
 * code", checkable then because there is finally something to read. Until then a gate that could not
 * fail would be worse than this one, and saying so is cheaper than discovering it.
 */
describe("no entry names a placeholder no throw site fills", () => {
  test("the catalog is placeholder-free", () => {
    const named = Object.entries(esErrors)
      .map(([key, message]) => [key, [...message.matchAll(PLACEHOLDER)].map((match) => match[1])] as const)
      .filter(([, placeholders]) => placeholders.length > 0);
    expect(named).toEqual([]);
  });
});
