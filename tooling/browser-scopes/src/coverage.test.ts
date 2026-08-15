// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFiles } from "@pithy-sh/cli/src/ci/sourceFiles";
import { describe, expect, it } from "vitest";

/**
 * What keeps `client.ts` from being a gate that cannot fail.
 *
 * The compile in `tsconfig.client.json` proves one thing well: **the scopes `client.ts` names are
 * reachable from a DOM-only program.** It proves nothing about the scopes `client.ts` does not name,
 * and nothing about where a scope will be declared tomorrow. Both holes are the shape #315 came
 * through — a constant sitting in the same module as the middleware that reads it — so both are
 * closed here rather than left to whoever adds the next capability.
 *
 * Two assertions, and they do different work:
 *
 * - **Coverage.** Every control-plane scope the kit declares appears in `client.ts`. A new capability
 *   is covered by the commit that adds it, not by somebody remembering this package exists.
 * - **The home module imports only types.** This is the structural half, and it is what actually
 *   fixes #315 rather than papering it. A scope's declaring module may import a type and nothing
 *   else, so naming a scope can never pull a Hono middleware, a `PithyHonoEnv`, or a Worker global
 *   into a browser program — whatever the compiler happens to tolerate this month.
 *
 * Neither assertion is derived from the thing it checks: the expected set is read off the capability
 * sources, the actual set is read off `client.ts`, and the compile that consumes both is `tsc`.
 */

/**
 * The capability sources this gate derives its expectation from, and the fixture it holds to them.
 *
 * **Each is one expression from `import.meta.url`, and that is load-bearing rather than a style.**
 * `.github/scripts/crossPackageReads.ts` resolves these literals statically to tell CI which suites a
 * diff must re-run — a suite reading across a package boundary is exactly the one `--affected` cannot
 * reach, since a scope added in a package this one does not depend on still changes its answer. Built
 * as `join(REPO_ROOT, "packages")` the script cannot follow the variable and scores the read as the
 * repo root, which plans this suite on every commit in the tree and, worse, plans it for reasons that
 * have nothing to do with what it reads.
 */
const PACKAGES = fileURLToPath(new URL("../../../packages", import.meta.url));
const CLIENT = fileURLToPath(new URL("./client.ts", import.meta.url));

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

/**
 * Every identifier a `client.ts` **import statement** brings in that is spelled like a scope constant.
 *
 * Scoped to the import block rather than swept over the whole file, because the file's own
 * `EVERY_CONTROL_PLANE_SCOPE` matches the same shape — and a gate that counts a name the fixture
 * declares itself is a gate one rename away from passing on nothing.
 */
const IMPORTED_SCOPE = /^import\s+\{([^}]*)\}\s+from\s+"[^"]+";$/gms;

/** An import statement, with the `type` keyword captured when the whole statement carries it. */
const IMPORT_STATEMENT = /^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";$/gms;

/**
 * Every module in `packages/` that declares at least one control-plane scope, and what it declares.
 *
 * The walk is `@pithy-sh/cli`'s `ci/sourceFiles`, not a seventh copy of one written here. That
 * primitive already answers the two questions this gate would otherwise get wrong on its own: it skips
 * `node_modules`, `dist` and `coverage`, and it drops `.test.ts` and `.d.ts` — a test file declaring a
 * scope-shaped fixture is not the contract, and counting one would make the expected set larger than
 * the kit actually ships.
 */
function scopeHomes(): Map<string, string[]> {
  const homes = new Map<string, string[]>();
  for (const { path, text } of sourceFiles(PACKAGES)) {
    const names = [...text.matchAll(DECLARATION)].map(([, name]) => name as string);
    if (names.length > 0) homes.set(path, names);
  }
  return homes;
}

describe("every control-plane scope is reachable from a browser program", () => {
  const homes = scopeHomes();
  const declared = [...homes.values()].flat().sort();

  it("finds the declarations at all", () => {
    // The vacuity floor, and it is set against the real population rather than against zero. The kit
    // declares 34 control-plane scopes across 9 modules today. A regex that silently stopped matching
    // — a rename of `ControlPlaneScope`, a formatter that broke the line — would otherwise turn both
    // assertions below into a comparison of two empty sets, which passes.
    expect(homes.size).toBeGreaterThanOrEqual(9);
    expect(declared.length).toBeGreaterThanOrEqual(35);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("names every one of them in client.ts", () => {
    const source = readFileSync(CLIENT, "utf8");
    const imported = [...source.matchAll(IMPORTED_SCOPE)]
      .flatMap(([, members]) => (members as string).split(","))
      .map((member) => member.trim())
      .filter((member) => member.length > 0);
    expect([...new Set(imported)].sort()).toEqual(declared);
  });

  it("declares each one in a module that imports only types", () => {
    // The type that scope constants are annotated with lives in a module that also builds the Zod
    // schema behind it, so that one module imports `zod` for value. Named by what it exports rather
    // than by its path: an allowlist of paths is a place to add a second entry without arguing for it.
    const typeHome = [...homes.keys()].find((file) =>
      /^export (const|type) ControlPlaneScope\b/m.test(readFileSync(file, "utf8")),
    );
    expect(typeHome).toBeTypeOf("string");

    const offenders: string[] = [];
    for (const file of homes.keys()) {
      if (file === typeHome) continue;
      const source = readFileSync(file, "utf8");
      for (const [, typeKeyword, specifier] of source.matchAll(IMPORT_STATEMENT)) {
        if (!typeKeyword) offenders.push(`packages/${relative(PACKAGES, file)} imports ${specifier} for value`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
