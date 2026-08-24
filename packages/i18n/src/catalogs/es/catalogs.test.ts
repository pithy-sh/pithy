// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MessageKey } from "@pithy-sh/core/src/i18n/catalog";
import { describe, expect, test } from "vitest";
import { esErrors } from "./errors";
import { es } from "./index";
import { esScreens } from "./screens";

/**
 * The Spanish screens and email copy, against the invariants that hold **inside** this package.
 *
 * **Until #441's verification pass these 122 keys were checked by nothing.** `esErrors` had
 * `errors.test.ts` beside it, holding it to `KitErrorPayload`; its two siblings had no file at all, and
 * a dropped key, a blank entry or a value left in English shipped green.
 *
 * ## What is here, and what is deliberately not
 *
 * Key **parity with English** is not here, and must not move here. The English for a screen lives baked
 * into a template under `@pithy-sh/ui-react` and the English for an email lives in `@pithy-sh/email`'s
 * `Capability.messages` — neither is a dependency of this package, and neither can become one. That
 * comparison is `packages/cli/src/ci/catalogCoverage.test.ts`, which is repo-wide precisely because the
 * property is only true as a set. It owns both directions and the placeholder comparison with it.
 *
 * What is here is everything a reader of *this* catalog alone can be wrong about: the population, the
 * key grammar, the domain rule, whether a sentence is actually a sentence, whether it is actually
 * Spanish, and whether the three files can be merged without one silently eating another.
 */

/** The three files, by the name a failure should send someone to. */
const FILES = {
  errors: esErrors,
  screens: esScreens,
} as const;

/** Every entry across all three, tagged with the file it came from. */
const ENTRIES = Object.entries(FILES).flatMap(([file, catalog]) =>
  Object.entries(catalog).map(([key, message]) => ({ file, key, message })),
);

/** `{placeholder}`, spelled exactly as `interpolate` spells it. */
const PLACEHOLDER = /\{([^}]*)\}/g;

/**
 * English words that are not also Spanish words — the same vetted list `errors.test.ts` carries, and
 * carried here rather than exported from there because a test file is not a module's public surface.
 *
 * The honest statement of what it can do: it catches a sentence left in English, not a bad translation.
 * The near misses are the point — `has` is second-person `haber`, and `es`, `no`, `de`, `que`, `son`
 * and `en` are all Spanish, so any of them here would fail the catalog for being correct.
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

describe("the catalogs are the size they are", () => {
  test("each file carries what it is for, so every comparison below has something in it", () => {
    // The anti-vacuity guard, per file rather than in total: either can empty on its own, and a total
    // would hide one going to zero while the other grew. Near-exact, measured on 2026-08-24 — 71
    // screen keys — and a floor rather than an equality for the one that grows with ordinary work. The
    // error catalog is pinned exactly, because it answers to a closed taxonomy.
    //
    // The email copy is counted by `@pithy-sh/email`'s own suite now, not here: it moved beside that
    // capability's English in #442, so the send Worker is built with it rather than sent it.
    expect(Object.keys(esScreens).length).toBeGreaterThanOrEqual(71);
    expect(Object.keys(esErrors)).toHaveLength(120);
    expect(ENTRIES.length).toBeGreaterThanOrEqual(191);
  });

  test("the assembled catalog is every key from both, with nothing lost to the merge", () => {
    // `es` is `{ ...esErrors, ...esScreens }`. Spreading is silent about a collision, so
    // the count is what says the merge kept everything.
    expect(Object.keys(es)).toHaveLength(ENTRIES.length);
  });

  test("no key is written in two of the three files", () => {
    // The failure the count above would report as a number and this reports as a name. Two files
    // claiming one key means one of them is dead text, forever, and the surviving one depends on the
    // spread order in `index.ts` — which nobody would think to read.
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { file, key } of ENTRIES) {
      const first = seen.get(key);
      if (first === undefined) seen.set(key, file);
      else collisions.push(`${key}: ${first} and ${file}`);
    }
    expect(collisions).toEqual([]);
  });
});

describe("every key is a catalog key", () => {
  test("each one spells as a `MessageKey`", () => {
    const refused = ENTRIES.filter(({ key }) => !MessageKey.safeParse(key).success).map(
      ({ file, key }) => `${file}: ${key}`,
    );
    expect(refused).toEqual([]);
  });

  test("the screens write under a screen's domain, never under `email/` or a code's", () => {
    // Screens are `auth/`, `payments/` and the adopter's own `app/` — the three trees `pithy ui add`
    // writes. A key that drifted into the email file's domain would be shadowed by it at merge.
    //
    // `client/` is the fourth and the only one with no capability behind it: the codes a browser SDK
    // mints when the request never reached a Worker at all. They belong here because a screen is what
    // renders them, and they are pinned by `./client.test.ts` against the exported sentinels rather
    // than against a list — see that file for why the two SDKs share two of the four codes.
    const domains = [...new Set(Object.keys(esScreens).map((key) => key.split("/")[0]))].sort();
    expect(domains).toEqual(["app", "auth", "client", "payments"]);
  });
});

describe("every entry is a sentence somebody can read", () => {
  test("none is blank", () => {
    // A blank reads like finished copy and would ship. `t()` answers with it happily.
    expect(ENTRIES.filter(({ message }) => message.trim() === "")).toEqual([]);
  });

  test("none is padded", () => {
    // Leading or trailing whitespace survives into a subject line and a button label alike, and is
    // invisible in every diff that carries it.
    expect(ENTRIES.filter(({ message }) => message !== message.trim()).map(({ key }) => key)).toEqual([]);
  });

  test("none is its own key", () => {
    // What a missing translation looks like when somebody filled the gap to make a gate go quiet.
    expect(ENTRIES.filter(({ key, message }) => message === key)).toEqual([]);
  });

  test("none is still English", () => {
    const english = ENTRIES.filter(({ message }) => ENGLISH_WORD.test(message)).map(
      ({ file, key }) => `${file}: ${key}`,
    );
    expect(english).toEqual([]);
  });

  test("the English detector really can fire, so the case above is not decorative", () => {
    expect(ENGLISH_WORD.test("Comprueba que el enlace no ha caducado.")).toBe(false);
    expect(ENGLISH_WORD.test("Check that the link has not expired.")).toBe(true);
  });
});

describe("nothing a catalog value carries is markup", () => {
  test("no entry holds a tag or an entity", () => {
    // **`subject` and the plain-text part are precompiled with escaping off**, so a value substituted
    // there is substituted verbatim. The HTML body escapes what it renders, which is what makes the
    // rule "no markup in a catalog" rather than "escape it carefully" — and it applies to a screen's
    // Spanish as much as to an email's, because a screen renders a catalog value as text.
    const markup = ENTRIES.filter(({ message }) => /[<>]|&[a-z]+;|&#\d+;/i.test(message)).map(({ key }) => key);
    expect(markup, "A catalog renders text. Put the markup in the template.").toEqual([]);
  });
});

describe("placeholders are spelled the way `interpolate` spells them", () => {
  test("every one is a bare identifier", () => {
    // `{ count }`, `{{count}}` and `{count.value}` all parse as text to `interpolate`, so each would
    // render as written — braces and all — in the reader's own language.
    const malformed: string[] = [];
    for (const { key, message } of ENTRIES) {
      for (const [, name] of message.matchAll(PLACEHOLDER)) {
        if (!/^[a-zA-Z0-9_]+$/.test(name ?? "")) malformed.push(`${key}: {${name}}`);
      }
    }
    expect(malformed).toEqual([]);
  });

  test("the catalogs really do carry placeholders, so that sweep is not over nothing", () => {
    // Re-measured on 2026-08-24 at 14, down from 30: the email copy moved to `@pithy-sh/email` in
    // #442 and took most of the interpolated sentences with it. Counted there now, in that package's
    // own suite, against the English it sits beside.
    const withParams = ENTRIES.filter(({ message }) => message.includes("{")).length;
    expect(withParams).toBeGreaterThanOrEqual(13);
  });

  test("no error entry carries one", () => {
    // Pinned in `errors.test.ts` too, and stated here because this file is where the sweep runs: no
    // throw site in the kit passes `params` yet, and `interpolate` leaves an unsupplied placeholder as
    // written. `Sala {code} llena.` on a caller's screen is worse than the generic clause.
    expect(Object.entries(esErrors).filter(([, message]) => message.includes("{"))).toEqual([]);
  });
});

describe("a plural family is complete", () => {
  test("every `.one` has an `.other` beside it", () => {
    // `plural()` looks up `<key>.<category>` and falls back to `<key>.other`. A family with only a
    // `.one` renders the key itself for every count but one, in a language with more forms than
    // English has.
    const orphans = Object.keys(es)
      .filter((key) => key.endsWith(".one"))
      .filter((key) => es[`${key.slice(0, -".one".length)}.other`] === undefined);
    expect(orphans).toEqual([]);
  });

  test("and every `.other` is part of a family somebody wrote", () => {
    const orphans = Object.keys(es)
      .filter((key) => key.endsWith(".other"))
      .filter((key) => es[`${key.slice(0, -".other".length)}.one`] === undefined);
    expect(orphans).toEqual([]);
  });

  test("there are plural families at all", () => {
    // Two, and pinned at two rather than at 95% of it: four of the six lived in the email copy, which
    // moved out in #442, and a population this small has no slack to give. It can only grow.
    expect(Object.keys(es).filter((key) => key.endsWith(".other")).length).toBeGreaterThanOrEqual(2);
  });
});
