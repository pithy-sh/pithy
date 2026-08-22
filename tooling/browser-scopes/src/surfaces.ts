// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, relative, sep } from "node:path";
import { sourceFiles, sourcePaths } from "@pithy-sh/cli/src/ci/sourceFiles";

/**
 * The three families a browser may import, derived from the tree rather than listed.
 *
 * Two suites in this package ask the same question of the same directory and used to answer it twice:
 * `coverage.test.ts` walked `packages/` for scope declarations, `browserSurface.test.ts` walked it for
 * response modules, and #430 needed a third walk for request schemas. Three derivations of one subject
 * is three things to drift, so they live here and each suite states what it asserts about them.
 *
 * ## `packages` is a parameter, and that is load-bearing rather than a style
 *
 * `.github/scripts/crossPackageReads.ts` tells CI which suites a diff must re-run by resolving runs of
 * adjacent string literals **statically, and only inside `*.test.ts`**. So the
 * `new URL("../../../packages", import.meta.url)` literal has to stay in the test files that read it. A
 * `PACKAGES` computed here instead would unregister this package's cross-package read: CI would stop
 * planning these suites on a capability change — #148 and #173 again — and `turboInputs.test.ts` would
 * turn red saying so.
 *
 * ## Why the scope family is derived by declaration and not by path
 *
 * The obvious glob is a capability's `src/http/scopes.ts`, and it finds four of the eight modules that fail
 * this gate. `@pithy-sh/audit`, `@pithy-sh/auth`, `@pithy-sh/email` and `@pithy-sh/secrets` declare their
 * control-plane scopes in a file called `guards.ts` that contains no guard — the same two type imports as
 * a `scopes.ts`, and the same reach into the Workers data layer. A path glob would have shipped #430
 * half-fixed and said so nowhere. What a module *declares* is the property the rule is about, so that is
 * what {@link scopeHomes} matches on.
 */

/**
 * How a control-plane scope constant is spelled, everywhere one is declared:
 * `export const AUDIT_TRAIL_READ_SCOPE: ControlPlaneScope = "audit:events:read";`
 *
 * The annotation is the marker rather than the `_SCOPE` suffix, because the suffix is used by strings
 * that are not control-plane scopes at all — `PLAY_SCOPE` is a Google OAuth URL, `CAPABILITY_SCOPE`
 * is an npm namespace, `GLOBAL_SCOPE` is an environment name. Matching on the type catches exactly
 * the ones a management client is meant to know and no others.
 */
const DECLARATION = /^export const ([A-Z][A-Z0-9_]*): ControlPlaneScope = /gm;

/** Whether `path` is a capability's `src/http/<name>.ts`. */
function underHttp(path: string): boolean {
  return dirname(path).endsWith(`${sep}src${sep}http`);
}

/**
 * Every response-schema module the kit ships, by the one path §HTTP gives them.
 *
 * The path is the derivation because §HTTP makes it one — "every admin response is a Zod object,
 * exported from the capability's `src/http/responses.ts`" — so there is exactly one such module per
 * capability and no judgment about which files count.
 */
export function responseModules(packages: string): string[] {
  return sourcePaths(packages, { keep: (name) => name === "responses.ts" }).filter(underHttp);
}

/**
 * Every request-schema module the kit ships, by the path §HTTP gives them.
 *
 * Same derivation as {@link responseModules} and for the same reason: "request schemas live in the
 * capability's `src/http/schemas.ts`". A request schema is a client's business for the same reason a
 * response schema is — §HTTP puts the request contract on the route line beside the verification
 * strategy, and a management client building a call needs the shape it may send.
 */
export function schemaModules(packages: string): string[] {
  return sourcePaths(packages, { keep: (name) => name === "schemas.ts" }).filter(underHttp);
}

/**
 * Every module in `packages` that declares at least one control-plane scope, and what it declares.
 *
 * The walk is `@pithy-sh/cli`'s `ci/sourceFiles`, not a seventh copy of one written here. That
 * primitive already answers the two questions this gate would otherwise get wrong on its own: it skips
 * `node_modules`, `dist` and `coverage`, and it drops `.test.ts` and `.d.ts` — a test file declaring a
 * scope-shaped fixture is not the contract, and counting one would make the expected set larger than
 * the kit actually ships.
 */
export function scopeHomes(packages: string): Map<string, string[]> {
  const homes = new Map<string, string[]>();
  for (const { path, text } of sourceFiles(packages)) {
    const names = [...text.matchAll(DECLARATION)].map(([, name]) => name as string);
    if (names.length > 0) homes.set(path, names);
  }
  return homes;
}

/** `packages/<name>/src/http/responses.ts` → `@pithy-sh/<name>/src/http/responses`. */
export function specifierFor(packages: string, path: string): string {
  const [pkg, ...rest] = relative(packages, path).split(sep);
  return `@pithy-sh/${pkg}/${rest.join("/").replace(/\.ts$/, "")}`;
}
