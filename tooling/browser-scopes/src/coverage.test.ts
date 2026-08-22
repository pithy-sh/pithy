// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scopeHomes } from "./surfaces";

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
 * - **The home module imports only types.** A scope's declaring module may import a type and nothing
 *   else, so naming a scope can never pull a Hono middleware or a `PithyHonoEnv` into a browser
 *   program as a *value* — whatever the compiler happens to tolerate this month.
 *
 * Neither assertion is derived from the thing it checks: the expected set is read off the capability
 * sources, the actual set is read off `client.ts`, and the compile that consumes both is `tsc`.
 *
 * ## The type-only rule is necessary and it was never sufficient (Jim, 2026-08-22)
 *
 * That second bullet used to claim it "actually fixes #315 rather than papering it". It does not, on
 * its own, and #430 is what that cost: every home obeyed it, and eight of the nine still compiled
 * `@cloudflare/workers-types`, `hono`, `kysely` and `kysely-d1`, because **the compiler follows a
 * type-only edge exactly as it follows a value one**. What this assertion buys is that a scope's home
 * cannot execute anything; what it does not buy is anything at all about the graph.
 *
 * The graph half lives next door in `browserSurface.test.ts`, which compiles each of these homes as its
 * own browser program and reports every package it reached. Both are kept: this one is cheap, reads as
 * a rule a contributor can follow while writing the file, and names the offending line; that one is the
 * property the rule exists to produce. The walk itself is `surfaces.ts`, shared with that suite so the
 * two cannot disagree about which modules are homes.
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
 * Every identifier a `client.ts` **import statement** brings in that is spelled like a scope constant.
 *
 * Scoped to the import block rather than swept over the whole file, because the file's own
 * `EVERY_CONTROL_PLANE_SCOPE` matches the same shape — and a gate that counts a name the fixture
 * declares itself is a gate one rename away from passing on nothing.
 */
const IMPORTED_SCOPE = /^import\s+\{([^}]*)\}\s+from\s+"[^"]+";$/gms;

/** An import statement, with the `type` keyword captured when the whole statement carries it. */
const IMPORT_STATEMENT = /^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";$/gms;

describe("every control-plane scope is reachable from a browser program", () => {
  const homes = scopeHomes(PACKAGES);
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
