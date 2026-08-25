// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Reading the locale a source file declares in its head — the reader for the marker `docs/I18N.md` publishes.
 *
 * A prose census reads every committed file as text and refuses the spellings a project does not write. This
 * repository runs one (`packages/cli/src/ci/americanEnglish.test.ts`: the words this project writes are
 * American), and any project that ships translated copy eventually needs the same thing, because a catalog
 * written in Spanish is prose that is *supposed* not to be English. A path list would answer that and is
 * exactly what a census must not grow — a list is right on the day it is written, wrong afterwards, and the
 * way it goes wrong is that the gate keeps passing. So the file says what it is instead, in one marker, in
 * its head, where a reader meets it: the **locale** it is written in, and that the copy is an **unreviewed
 * first pass**. Both facts are load-bearing and neither is checkable from the outside.
 *
 * ## The half that is easy to get backwards
 *
 * **The marker exempts the file's quoted values, not the file.** A catalog is not written in Spanish — its
 * *values* are. Everything around them is a docblock, an import and an identifier: the project's own English
 * prose, and exactly as subject to the rule as any other file's. So a declaring file widens what counts as a
 * value — every quoted run, whole sentences included, rather than only the whitespace-free tokens exempt
 * everywhere else — and every character outside those quotes is censused as it would be anywhere.
 *
 * Reading the marker as *skip this file* is the port that goes wrong, and it goes wrong quietly. It made this
 * repository's own `es/errors.ts` a place where a twenty-seven-line English argument went unread, which is a
 * gate that cannot fail on most of what it is looking at, and it costs an adopter the docblocks of every
 * translated catalog they ever add.
 *
 * **`en` and `en-*` are a declaration and never an exemption**, which is why {@link localeDeclared} hands back
 * the tag rather than a yes or a no. The words a project writes *in English* are the ones a census is about,
 * and a marker cannot become a way to opt English prose out of it. The caller decides what a tag means;
 * treating `en` as translated is the same mistake as treating `es` as skippable.
 *
 * ## Why it lives in `core/src/i18n`
 *
 * The folder is the import path, so it is named for the caller. The marker is a locale declaration — the same
 * thing `./locale` and `./catalog` are about, one artifact earlier — and an adopter reaching for it is asking
 * a question about translated copy, not about linting. It is deliberately not in the CLI: the CLI is a
 * development tool an adopter's own test suite has no reason to depend on, and this is the kit's precedent for
 * a pure textual scanner that a repository's tests want back (`../entitlement/gateScan`, which exports
 * `withoutComments` for the same reason). No `node:` import, no filesystem: the caller brings the text,
 * whether from a walked directory or from `import.meta.glob(…, "?raw")` inside a Workers-typed program.
 *
 * The census that owns the rest of the rule stays where it is. What ships here is the pair a port gets wrong.
 */

/**
 * What a file written in a language other than English declares in its head.
 *
 * The exact spelling is published in `docs/I18N.md` — `LOCALE <tag>`, an em dash, and the unreviewed-first-pass
 * sentence — and `packages/cli/src/ci/americanEnglish.test.ts` reads the line out of that document and holds it
 * to this pattern, so an adopter copying the published marker cannot copy one that matches nothing. The tag is
 * captured, never merely detected, because the caller's decision turns on which language it names.
 */
const LOCALE_DECLARED = /\bLOCALE ([a-z]{2,8}(?:-[A-Za-z0-9]{1,8})*) — an unreviewed first pass\./;

/**
 * How far into a file the marker has to be, so a file mentioning it in prose is still read.
 *
 * A documented number rather than a tuning knob: `docs/I18N.md` publishes this window to adopters, and
 * `packages/cli/src/ci/americanEnglish.test.ts` holds the count that document states to where this reader
 * actually stops — so moving the number here fails the build until the document moves with it. This module's
 * own test pins both sides of the boundary. It is an implementation detail of {@link localeDeclared} and is
 * not exported — a caller hands over a whole source and gets an answer.
 */
const HEAD_LINES = 25;

/**
 * The locale tag this source declares in its head, or `null` if it declares none.
 *
 * `null` is the ordinary answer: almost every file in a tree declares nothing, and a file that does is saying
 * something about its own values, not asking to be skipped. See this module's docblock for what a caller owes
 * the answer — in particular that `en` comes back like any other tag and exempts nothing.
 */
export function localeDeclared(source: string): string | null {
  for (const line of source.split("\n").slice(0, HEAD_LINES)) {
    const found = LOCALE_DECLARED.exec(line);
    if (found !== null) return found[1] as string;
  }
  return null;
}

/**
 * Every span on one line whose quoted content is a value rather than prose — as `[open, close)` offsets.
 *
 * `open` is the first character inside the quote and `close` is the closing quote, so a match at or after
 * `open` and ending at or before `close` sits inside a value. Left to right, in whichever of the three quote
 * characters opened it.
 *
 * By default a run holding whitespace is a sentence, not a value, and **a span that turns out to hold one is
 * passed over rather than skipped**: the scan keeps reading inside it, which is how a backticked token inside
 * a prose string literal still counts — this repository names wire values that way in a `.describe()`.
 *
 * `everyQuoted` widens that to include the sentences, for one case and one only: a line in a file that has
 * declared itself written in another language, where the quoted runs are the translation. It is the mechanism
 * the marker drives, and it is why the marker exempts a file's values without exempting the file.
 *
 * A run is one line's worth. A quote that never closes on its line opens no value, so the inner lines of a
 * multi-line template literal are read as prose — deliberately, since that is where a long English argument
 * would otherwise hide.
 */
export function valueSpans(line: string, everyQuoted = false): [number, number][] {
  const spans: [number, number][] = [];
  for (let index = 0; index < line.length; index += 1) {
    const quote = line[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    const close = line.indexOf(quote, index + 1);
    if (close === -1) continue;
    const inner = line.slice(index + 1, close);
    if (inner.length === 0) continue;
    if (!everyQuoted && /\s/.test(inner)) continue;
    spans.push([index + 1, close]);
    index = close;
  }
  return spans;
}
