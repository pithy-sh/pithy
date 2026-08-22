// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TEMPLATE_DIR } from "./templates";

/**
 * **The palette is declared as a set, or not at all** (#391, item I).
 *
 * `templates/src/pithy-screens.css` reads each of its colors out of a custom property an adopter may
 * declare — `var(--fg, #111111)` — and stands up on the fallback when they declare none. Two states
 * work: their palette, or Pithy's. **The state that does not work is half of each**, and it is the one
 * no fallback can detect: a screen whose background is theirs and whose text is Pithy's renders gray on
 * gray, with a clean build, a green suite and nothing in any log.
 *
 * The kit shipped exactly that. `--danger` was read by `pithy-screens.css`, named as one of the seven in
 * `docs/UI.md` and in both stylesheets' own docblocks, and declared in `styles.css` by nobody.
 *
 * ## Why this one is kept and not seeded
 *
 * By #391's rule it should travel: `src/styles.css` is the adopter's, editing it is the entire point of
 * the file, and every edit is a chance to drop a token out of the set. **It cannot travel, and the
 * reason is a wall rather than a judgment.**
 *
 * The invariant is stated in CSS text, and a seeded gate would have to read that text from inside the
 * client program the screens compile in — which has no Node types, deliberately, because `.tsx` is what
 * keeps the browser build out of the Worker's own program. The bundler route is `?raw`, and **Vitest
 * stubs CSS modules to the empty string by default**: `import styles from "./styles.css?raw"` and
 * an eager raw glob over the same file both answer `""` in a scaffolded project, under
 * the plain `vitest run` an adopter already has. Every case in this file would then sweep an empty set
 * and pass. **A gate that passes over nothing is worse than no gate**, because it is read as coverage.
 *
 * So it is kept here, in the node program, where the files can actually be read — and `seededGates.test.ts`
 * records that, with this reason, rather than leaving the ledger looking complete.
 *
 * What is lost is real and worth naming: this catches the *kit* shipping a half-set, which is what
 * happened, and it cannot catch an adopter's later edit. The honest scope of the fix, written down.
 */

/** Where the two stylesheets are, in the tree the CLI copies from. */
const SHEET = (name: string): string => join(TEMPLATE_DIR, "src", name);

/**
 * `text` with every at-rule block removed — `@media`, `@supports`, `@container`.
 *
 * **This is the whole reason the check is not a one-line regex.** A token declared *only* inside
 * `@media (prefers-color-scheme: dark)` is not declared: in light mode Pithy's fallback applies and the
 * adopter's does not, which is the half-set failure exactly, on half their visitors. A sweep counting a
 * conditional declaration passes against it — and did, the first time this gate was planted against.
 */
function unconditional(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@") {
      out += text[index];
      continue;
    }
    const open = text.indexOf("{", index);
    if (open === -1) break;
    let depth = 0;
    let cursor = open;
    for (; cursor < text.length; cursor += 1) {
      if (text[cursor] === "{") depth += 1;
      else if (text[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    index = cursor;
  }
  return out;
}

/**
 * Every custom property Pithy's stylesheet reads *with a fallback* — the set the adopter's owes.
 *
 * The fallback is what makes it theirs to supply. `var(--pithy-fg)` has none: those are Pithy's own,
 * derived from these, and not part of the seam. Neither side of this comparison is written down here.
 */
async function tokensRead(): Promise<string[]> {
  const text = await readFile(SHEET("pithy-screens.css"), "utf8");
  return [...new Set([...text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,/gi)].map((match) => match[1] ?? ""))];
}

/** Every custom property the adopter's stylesheet declares unconditionally — the ones that always apply. */
async function tokensDeclared(): Promise<Set<string>> {
  const text = unconditional(await readFile(SHEET("styles.css"), "utf8"));
  return new Set([...text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1] ?? ""));
}

test("the reading every case below depends on is calibrated before any of them is trusted", async () => {
  // A gate over this file's own instrument. Without it, the cases pass over whatever `unconditional`
  // happened to return, and a matcher returning nothing looks exactly like a stylesheet with no defect.
  const sheet = ":root { --fg: #111; }\n@media (prefers-color-scheme: dark) {\n  :root { --danger: #f2b8b5; }\n}\n";
  expect(unconditional(sheet)).toContain("--fg");
  // The one that matters: a token existing only in the dark block is not one the stylesheet declares,
  // because in light mode Pithy's fallback applies and the adopter's does not.
  expect(unconditional(sheet)).not.toContain("--danger");
  // A block after the at-rule is not swallowed with it.
  expect(unconditional(`${sheet}:root { --accent: #d4a017; }`)).toContain("--accent");

  // And the seam is still a seam. A stylesheet rewritten to hardcoded colors, or a pattern that stopped
  // matching, would make every assertion below sweep an empty set and say nothing.
  const read = await tokensRead();
  expect(read.length, "pithy-screens.css reads no token with a fallback — the palette seam is gone").toBeGreaterThan(3);
});

test("every token Pithy's screens read is one the seeded stylesheet declares", async () => {
  const read = await tokensRead();
  const declared = await tokensDeclared();

  // Declaring none is a supported state: Pithy's fallbacks carry the screens alone. It is the half-set
  // that reads badly, so the rule only bites once a palette has been started — as the seeded one has.
  expect(declared.size, "the seeded stylesheet declares no palette at all").toBeGreaterThan(0);

  const missing = read.filter((token) => !declared.has(token)).sort();
  expect(
    missing,
    `templates/src/styles.css declares a palette and omits ${missing.join(", ")} — the screens take those from Pithy's defaults and the rest from the adopter's`,
  ).toEqual([]);
});

test("and declares them where they always apply, not only in one color scheme", async () => {
  const read = await tokensRead();
  const declared = await tokensDeclared();
  const text = await readFile(SHEET("styles.css"), "utf8");

  // The same rule, about the half nobody looks at. A palette declared only under
  // `prefers-color-scheme: dark` is Pithy's colors in daylight and the adopter's at night — the
  // half-set failure split by visitor rather than by token, and it builds just as clean.
  const conditionalOnly = read.filter((token) => text.includes(`${token}:`) && !declared.has(token)).sort();
  expect(
    conditionalOnly,
    `templates/src/styles.css declares ${conditionalOnly.join(", ")} only inside an at-rule, so it applies to some visitors and not others`,
  ).toEqual([]);
});
