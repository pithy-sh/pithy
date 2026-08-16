// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **A screen this command writes renders styled, or the command says exactly what is missing.**
 *
 * `pithy ui add` writes only what does not exist, which is right and is what makes a backfill safe: an
 * adopter's `src/styles.css` is theirs, and overwriting it would destroy their design. But the screens
 * and the rules they need were once one file, so the backfill wrote `routes/pithy/sign-in.tsx` —
 * rendering `stack`, `divider` and `secondary` — while correctly skipping the only file that defined
 * them, and reported the result as `created`. An adopter's first sight of the feature they had just
 * enabled was an unstyled login page.
 *
 * The structural half of the fix is `src/pithy-screens.css`: Pithy's screens carry their own stylesheet,
 * in the `base` group, so the run that writes a screen writes its rules. This module is the half that
 * keeps it true — it extracts what the screens render and what the stylesheets define, and diffs them.
 *
 * It runs in three places, and the third is why it is a module rather than a test helper:
 *
 * - **As a gate**, over the template itself. A screen gaining a class whose rule lives somewhere the
 *   backfill never writes fails CI. That is the drift that produced this, in that direction.
 * - **As output**, at `pithy ui add`, over what that run left on disk. A stylesheet the adopter has
 *   since edited, a `pithy-screens.css` they deleted, a screen of their own under `routes/pithy/` —
 *   none of those are things the template can be checked for, and all of them end in the same unstyled
 *   screen. So the report names the classes rather than claiming the screens are fine.
 * - **As a gate again**, at `pithy ui sync --check`, where a non-empty finding exits 1 (#401). It used
 *   to run only at scaffold, print, and not affect the exit — but `styles.css` is the adopter's, and the
 *   ordinary way a screen goes unstyled is an edit a week later. A one-shot warning cannot see that.
 *   `docs/UI.md` § *Two stylesheets, and why* is where an adopter reads this.
 */

/** Where Pithy's own screens live inside a scaffolded Worker — the only files this checks. */
export const PITHY_SCREEN_DIR = "src/routes/pithy/";

/**
 * The class names a React source renders.
 *
 * Both `className="a b"` and `className={cond ? "a" : "b"}` are read, because both put a literal class
 * name in the markup and only one of them is the shape the templates happen to use today. An expression
 * with no literal at all contributes nothing, which is the honest answer — a class assembled at runtime
 * is not something a static check can claim to have verified.
 *
 * ## The blind spot, stated because a template author will meet it
 *
 * **`className={CHECKOUT_FRAME}` contributes nothing.** A bare identifier is an expression with no
 * literal in it, so this reads no name from it, and the check downstream reports the screen as fully
 * styled. Today that is harmless and deliberate: `CHECKOUT_FRAME` is `"pithy-checkout"`, the hosted
 * checkout's mount point, and it is defined by no stylesheet Pithy ships because it is an adopter hook.
 * The one Pithy-rendered class with no rule anywhere is exactly the one this cannot see (#391 item E).
 *
 * A future constant that *is* meant to be styled would be invisible the same way, and now that a finding
 * fails `pithy ui sync --check` (#401), invisible means it passes. Resolving identifiers across files is
 * not the fix — it would surface `pithy-checkout` and force an exemption list for a class that is
 * correctly undefined. **Write the name as a literal in the `className` if you want it checked.**
 */
export function renderedClassNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/className\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/g)) {
    const literals =
      match[1] !== undefined ? [match[1]] : [...(match[2] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    for (const literal of literals) {
      for (const name of (literal ?? "").split(/\s+/)) if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * The class names a stylesheet defines.
 *
 * Read from the selector preludes rather than by scanning the whole text, so a `.secondary` inside a
 * comment or a `content: ".x"` string is not mistaken for a rule. A prelude is whatever precedes a `{`
 * since the last `{`, `}` or `;`, which walks nested blocks at any depth — and that is what lets it see
 * inside `@layer` and `@media`. The layer is how these rules stay overridable, so a reader that could
 * not look into one would report every class as undefined.
 */
export function definedClassNames(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const names = new Set<string>();
  let prelude = "";
  for (const character of withoutComments) {
    if (character === "{") {
      // An at-rule's prelude (`@layer pithy`, `@media …`) names no selector; its body is walked next.
      if (!prelude.trim().startsWith("@")) {
        for (const match of prelude.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) if (match[1]) names.add(match[1]);
      }
      prelude = "";
    } else if (character === "}" || character === ";") {
      // A declaration ends at `;` and a block at `}`; either way what came before is not a selector.
      prelude = "";
    } else {
      prelude += character;
    }
  }
  return [...names].sort();
}

/** One scaffolded file, keyed the way `pithy ui` keys everything: relative to `apps/<worker>/`. */
export type ScaffoldedFiles = Readonly<Record<string, string>>;

/**
 * The class names Pithy's screens render that no stylesheet in the same set defines — empty, or the
 * exact list a report has to name.
 *
 * Every `.css` in the set counts, not only Pithy's own: a project whose stylesheet already defines
 * `stack` is not broken, and a check that insisted the rule live in a particular file would be
 * enforcing a layout rather than the property that matters.
 */
export function unstyledScreenClasses(files: ScaffoldedFiles): string[] {
  const defined = new Set<string>();
  for (const [path, contents] of Object.entries(files)) {
    if (path.endsWith(".css")) for (const name of definedClassNames(contents)) defined.add(name);
  }
  const missing = new Set<string>();
  for (const [path, contents] of Object.entries(files)) {
    if (!path.startsWith(PITHY_SCREEN_DIR) || !path.endsWith(".tsx")) continue;
    for (const name of renderedClassNames(contents)) if (!defined.has(name)) missing.add(name);
  }
  return [...missing].sort();
}
