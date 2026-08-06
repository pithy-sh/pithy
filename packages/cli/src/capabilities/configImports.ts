// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * One named import found in a `pithy.config.ts`. The three commands that write that file — `add`,
 * `remove`, and `eject` — all need the same answer about it, and each used to hand-build the exact
 * line it expected instead. That is why `pithy add secrets` could write an import `remove` would not
 * take out and `eject` would not find.
 */
export interface ConfigImport {
  /** The statement exactly as it appears — leading indentation and trailing `;` included. */
  statement: string;
  /** The module specifier it imports from, unquoted. */
  specifier: string;
}

/**
 * A named import statement — `import { a, type B, c as d } from "…";`.
 *
 * Leading whitespace is tolerated: indentation is cosmetic, and an anchored `^import` treated a
 * two-space indent as no import at all, which writes a second one. `import type { … }` does not
 * match — it binds no value, so it cannot be the import a registration call needs. Neither do the
 * default and namespace forms (`import auth from …`, `import * as auth from …`): a capability
 * factory is a named export, and an adopter who binds the name that way collides at typecheck,
 * loudly, rather than getting the wrong thing composed.
 */
const NAMED_IMPORT = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2;?/gm;

/**
 * The named import that binds `name`, or `undefined` when nothing does.
 *
 * **Keyed on the binding, not the specifier.** Where a capability is imported from is the adopter's
 * business — a deep path, an ejected copy — but the *name* is the thing a registration call resolves
 * through, so that is what identifies the import. What the specifier is then used for is a separate
 * question each caller answers with {@link isCapabilityImport}.
 */
export function findNamedImport(source: string, name: string): ConfigImport | undefined {
  for (const match of source.matchAll(NAMED_IMPORT)) {
    for (const clause of (match[1] ?? "").split(",")) {
      const trimmed = clause.trim();
      if (trimmed === "" || trimmed.startsWith("type ")) continue;
      // `x as y` binds `y`; an alias means the adopter is using a different name, and this is not it.
      const parts = trimmed.split(/\s+as\s+/);
      if ((parts[1] ?? parts[0] ?? "").trim() !== name) continue;
      return { statement: match[0], specifier: match[3] ?? "" };
    }
  }
  return undefined;
}

/**
 * The module specifier a capability's factory is imported from — the package's `src/index` barrel.
 *
 * Exported because it is a claim about another package's files, and `catalog.test.ts` checks it
 * against them. `@pithy-sh/secrets` shipped with no `src/index.ts`, so `pithy add secrets` wrote a
 * specifier nothing answered and every later `pithy` command failed loading the config. The test
 * reads this string rather than a copy of it, so the two cannot drift apart again.
 */
export function capabilityImportSpecifier(pkg: string): string {
  return `${pkg}/src/index`;
}

/**
 * Whether a specifier is one the capability itself can be behind: its package (the `src/index`
 * barrel or any deeper path into it), or the local copy an eject wrote.
 *
 * Deep paths count because an adopter reaching past the barrel is still importing *this capability*,
 * and the three commands have to agree on that. They did not: `add` blessed a hand-edited deep
 * import, `remove` left it behind while uninstalling the package, and `eject` refused to find it.
 * Anything else is the adopter's own module that happens to share the name — not ours to rewrite,
 * and not ours to delete.
 */
export function isCapabilityImport(specifier: string, pkg: string, ejectPath: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`) || specifier === ejectPath;
}

/**
 * The source with an import statement taken out, including the newline it sat on so no blank line is
 * left behind. A no-op if the statement is not there.
 */
export function withoutImport(source: string, found: ConfigImport): string {
  const index = source.indexOf(found.statement);
  if (index === -1) return source;
  const end = index + found.statement.length;
  return source.slice(0, index) + source.slice(source.startsWith("\n", end) ? end + 1 : end);
}
