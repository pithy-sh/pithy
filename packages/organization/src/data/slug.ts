// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_SLUG_LENGTH } from "./organization";

/**
 * Turning a display name into the short name that addresses it.
 *
 * **The bound and the pattern are the column's, read from it rather than restated here.** A second
 * definition of *what a slug is* would let the deriver and the table drift, and the drift would only
 * ever show as a write refused deep inside a transaction.
 *
 * ## Why this is a module and not four lines in a handler
 *
 * The obvious four lines are `name.toLowerCase().replace(/[^a-z0-9]+/g, "-")`, and they are what the
 * dashboard shipped in the browser. They reduce every name not written in Latin script — Chinese,
 * Japanese, Korean, Russian, Greek, Arabic, Hebrew, Thai — to the **same empty string**. One base for a
 * whole half of the world's names is a base that can be exhausted, and the account that then cannot be
 * founded is the one whose name is not English. That is the defect this replaces.
 *
 * ## What reduces, reduces; what does not gets a token of its own
 *
 * Three steps of folding, in order, and each earns its place:
 *
 * 1. **Compatibility decomposition, then the marks come off.** `café` is `cafe` and `ＡＣＭＥ` is
 *    `acme`, because Unicode already says so and we are only reading the answer.
 * 2. **The Latin letters Unicode does not decompose.** `ß`, `æ`, `œ`, `ø`, `đ`, `ð`, `þ`, `ł`, `ı` are
 *    letters rather than decorated letters, so no normalization touches them — and without this line a
 *    Danish, German, Polish or Turkish name falls through to a token as if it were written in another
 *    script. Nine entries, for the script the rest of this function already serves.
 * 3. **An apostrophe closes a word rather than splitting it.** `Cai's Studio` is two words;
 *    `cai-s-studio` says it is three.
 *
 * **And then it stops.** There is no Cyrillic table, no Greek table, no pinyin. A table for two scripts
 * and not the other twenty is a promise the kit half keeps — a Russian adopter gets a readable slug and
 * an Arabic one does not, from the same function, with nothing in the rule that explains why. So what
 * does not reduce to ASCII gets {@link fingerprint}: a stable short token derived from the name itself,
 * distinct per name, which is the property the exhaustible shared base lacked. It is not pretty, and a
 * slug that is not in any URL does not need to be — what it needs is to exist, to be the caller's alone,
 * and to be the same one tomorrow.
 */

/**
 * The letters Latin script spells with, which Unicode holds as letters rather than as decorations.
 *
 * Every one of these survives `NFKD` unchanged, so they reach the alphanumeric filter as *not a letter*
 * and take a name with them. Lowercase keys only: the fold runs after `toLowerCase`.
 */
const LATIN_LETTERS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
};

/** The apostrophes people actually type. Removed, so a possessive does not become two words. */
const APOSTROPHES = /['‘’ʼ՚]/gu;

/** Everything Unicode marks as a combining mark, left behind by the decomposition. */
const COMBINING_MARKS = /\p{M}+/gu;

/** Anything the column will not hold, in runs, so a comma and a space are one hyphen and not two. */
const NOT_SLUG_CHARACTERS = /[^a-z0-9]+/g;

/** The keys of {@link LATIN_LETTERS}, as one pass. */
const LATIN_LETTER_PATTERN = new RegExp(`[${Object.keys(LATIN_LETTERS).join("")}]`, "gu");

/**
 * What a derived slug is called when the name reduced to nothing.
 *
 * A word rather than a bare token, so the value reads as something a program chose rather than as
 * corruption, and so the slug begins with a letter wherever one is drawn.
 */
const DERIVED_PREFIX = "org";

/**
 * A stable short token for a name, so two names that both reduce to nothing still differ.
 *
 * FNV-1a over code points, in base 36. **Not a cryptographic digest and not required to be one**: the
 * job is to spread names across the space, not to resist anybody. Two names may still land on the same
 * token — the unique constraint is the arbiter either way, and a collision retries with a suffix, which
 * is the same path a genuinely duplicated name takes.
 */
function fingerprint(name: string): string {
  let hash = 0x811c9dc5;
  for (const character of name) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

/**
 * Derive a slug from a display name. Total: every string in, a slug the column accepts out.
 *
 * Deterministic, deliberately. The base has to be the same on every attempt, because a random base
 * would make the retry loop's first try meaningless and would hand the same person a different address
 * each time they tried to found the same account.
 */
export function deriveSlug(name: string): string {
  const folded = name
    // Decomposed before it is lowercased, because a compatibility form can decompose *to* capitals:
    // `㎒` is `MHz`, and lowercasing first leaves the `MH` to be thrown away as punctuation.
    .normalize("NFKD")
    .toLowerCase()
    .replace(COMBINING_MARKS, "")
    .replace(APOSTROPHES, "")
    .replace(LATIN_LETTER_PATTERN, (letter) => LATIN_LETTERS[letter] ?? letter);
  const reduced = folded.replace(NOT_SLUG_CHARACTERS, "-").replace(/^-+/, "").replace(/-+$/, "");
  // Bounded at the column's own maximum. The cut can land inside a word — a truncated word still reads,
  // and a hyphen is trimmed back off so the result never ends on one.
  const bounded = reduced.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
  return bounded.length > 0 ? bounded : `${DERIVED_PREFIX}-${fingerprint(name)}`;
}

/**
 * Add a suffix to a slug that is taken, keeping the result inside the column's bound.
 *
 * **The base gives way, never the suffix.** The suffix is the whole of what makes the next attempt land;
 * a truncation that ate it would retry with the value that just collided. A base with no room left is
 * dropped rather than leaving a leading hyphen, which is not a slug.
 */
export function suffixSlug(base: string, suffix: string): string {
  const room = MAX_SLUG_LENGTH - suffix.length - 1;
  if (room <= 0) return suffix.slice(0, MAX_SLUG_LENGTH);
  const head = base.slice(0, room).replace(/-+$/, "");
  return head.length > 0 ? `${head}-${suffix}` : suffix.slice(0, MAX_SLUG_LENGTH);
}
