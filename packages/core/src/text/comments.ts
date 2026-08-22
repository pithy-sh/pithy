// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * `source` with every comment blanked — the one comment stripper this repository's gates share.
 *
 * A tripwire that reads source has to walk past prose, because this repository's docblocks quote the
 * very thing their gate forbids: a paragraph explaining why a config must never read `process.env`, a
 * header naming `@cloudflare/workers-types` in a sentence. Blanking is what makes the prose invisible
 * without making the file shorter.
 *
 * **Blanked rather than deleted: every character becomes a space and every newline survives**, so the
 * line number in a failure is the line number in the file, a caller may split on `\n` and index, and a
 * caller may slice the blanked text at an offset it measured on the original. Deleting is the cheaper
 * thing to write and it silently joins the code either side of a block comment onto one line, which
 * costs the position of everything below it.
 *
 * **It walks the source rather than matching a pattern, because the pattern has two measured false
 * negatives.** One `replace` over a comment pattern has no notion of a string, and a string is where a
 * comment can be forged:
 *
 * - `const base = "https://api.cloudflare.com";` opens a line comment at the `//` inside the URL, and
 *   everything after it on that line is blanked — a `process.env.CLOUDFLARE_API_TOKEN` read beside it,
 *   a `D1Database` beside it, whatever the caller was looking for.
 * - `include: ["**\/*.workers.test.ts"]` opens a block comment at the `/*` inside the glob, which runs
 *   to the next `*\/` anywhere later in the file — the next docblock will do — and blanks every line
 *   between.
 *
 * Both were measured against planted source, and both are silent: the scan reports nothing and passes.
 * A prohibition that a URL can switch off is worse than no prohibition, because the file it exempts
 * looks scanned.
 *
 * **Strings are stepped over, not blanked.** The job is comments, and preserving a string keeps a real
 * read inside a template — `` `${process.env.CLOUDFLARE_API_TOKEN}` `` — visible to the caller. A string
 * that merely *contains* the text is then a false positive, which is the direction a gate should fail in.
 *
 * **A regex literal is stepped over too**, because `/^["']|["']$/` is a quote a string state would open
 * on, and a runaway string swallows every line to the next quote. Told apart from division by the last
 * significant character: a `/` where a value may begin starts a literal, and one after an operand is a
 * divide. An unterminated string or regex stops at the newline, so a bad guess costs one line rather
 * than the rest of the file.
 *
 * ## Why it lives in `@pithy-sh/core`, of all places
 *
 * It was written in `@pithy-sh/cli`'s `ci/sourceFiles.ts`, beside the walk its first three callers used
 * (#437). `packages/core/src/worker-safety.test.ts` is the caller that could not follow it there:
 * it guards which bare specifiers core's shipped source imports, it had the naive pattern, and
 * `@pithy-sh/core` must never depend on `@pithy-sh/cli` — core is bundled into the adopter's Worker, so
 * its dependency set is a shipped surface and the arrow runs cli → core only (#439).
 *
 * The alternatives were a documented copy and a drift gate over two copies. That pattern is real here —
 * `envIsolation.workers.test.ts` restates `CLOUDFLARE_ENV_KEYS` under exactly this constraint — and it
 * holds for two string constants, which a gate can compare for equality. Over a hundred-line walk it
 * degrades into comparing function text, which changes on a rename and says nothing about behavior.
 *
 * So the third home, and core is the only package every caller already imports: the CLI, `email`,
 * `payments` and `ui-react` all declare it, and `worker-safety.test.ts` reaches it with a relative path.
 * The cost is honest and small. This is source-text tooling inside the package that ships into a Worker
 * — but core has no barrel, so a module nothing imports is never reached by an adopter's bundler at all,
 * and the price is bytes in a tarball rather than bytes in a Worker. And it earns its keep as a Worker
 * neighbor on its own terms: **it imports nothing and touches no Node builtin**, which is the property
 * `worker-safety.test.ts` exists to enforce, so the gate now polices the stripper it reads with.
 */
export function blankComments(source: string): string {
  let out = "";
  let previous = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const pair = source.slice(index, index + 2);
    if (pair === "//" || pair === "/*") {
      const stop = endOfComment(source, index, pair);
      out += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const stop = endOfQuoted(source, index, char, char !== "`");
      out += source.slice(index, stop);
      index = stop;
      previous = char;
      continue;
    }
    if (char === "/" && VALUE_POSITION.has(previous)) {
      const stop = endOfRegex(source, index);
      out += source.slice(index, stop);
      index = stop;
      previous = "/";
      continue;
    }
    out += char;
    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return out;
}

/**
 * After one of these, a `/` opens a regex literal; after anything else it divides. The empty string is
 * the start of the file. A wrong guess is bounded — see {@link endOfRegex}.
 */
const VALUE_POSITION = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
]);

/** Where a comment ends. An unterminated block comment runs to the end of the file, as it does for tsc. */
function endOfComment(source: string, start: number, pair: string): number {
  if (pair === "//") {
    const newline = source.indexOf("\n", start);
    return newline === -1 ? source.length : newline;
  }
  const close = source.indexOf("*/", start + 2);
  return close === -1 ? source.length : close + 2;
}

/** Where a quoted run ends: past its closing quote, or at the newline a single-line quote cannot cross. */
function endOfQuoted(source: string, start: number, quote: string, singleLine: boolean): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === "\n" && singleLine) return index;
  }
  return source.length;
}

/** Where a regex literal ends. A `/` inside a character class does not close it; a newline does. */
function endOfRegex(source: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "\n") return index;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index + 1;
  }
  return source.length;
}
