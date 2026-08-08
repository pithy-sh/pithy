// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "../ci/sourceFiles";
import { CATALOG, capabilityPackageDir, capabilityPackageName } from "./catalog";
import { capabilityImportSpecifier } from "./configImports";

const run = promisify(execFile);

/** `packages/` — this file lives at `packages/cli/src/capabilities/`. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..");

/** The repository. Asserted by the walk test below, so a moved file fails loudly. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/**
 * Every capability's config entry point must import in a plain Node process.
 *
 * `pithy add` writes `import { x } from "@pithy-sh/x/src/index"` into the adopter's `pithy.config.ts`
 * ({@link capabilityImportSpecifier}), and that file is loaded by *Node-side* tooling — `pithy upgrade`,
 * `pithy migrate`, `pithy deploy`, every command that needs to know what the project composes. So a
 * capability entry point that reaches a Workers-only module is not a Workers concern at all: it takes the
 * whole CLI down for any project composing it, and the failure surfaces as "could not load pithy.config.ts",
 * naming the wrong cause.
 *
 * `@pithy-sh/multiplayer` did exactly this (#172): its entry point re-exported the `MultiplayerSession`
 * Durable Object, and its routes imported two string constants out of that same module, so
 * `import("@pithy-sh/multiplayer/src/index")` dragged in `cloudflare:workers` and threw outside workerd.
 *
 * **The invariant, not a blocklist.** This does not scan for `cloudflare:workers`, `node:` builtins, or any
 * other named module — it performs the import and requires it to succeed. Whatever a future entry point
 * reaches for that Node cannot resolve fails here, without anyone having predicted the name.
 *
 * Each import runs in its own `bun` process, from inside the capability's own package directory, so
 * resolution is the real thing: the module graph an adopter's `pithy.config.ts` pulls in, not vitest's
 * transform pipeline with the CLI's `node_modules` in scope. A runtime-only module resolved by a test
 * runner's aliasing would be the one way to pass this while still being broken in the field.
 *
 * **Scope is {@link CATALOG}** — the set `pithy add` can write a config line for. A package that ships a
 * capability but is not yet catalogued is not reachable from a `pithy.config.ts` and so cannot break one;
 * it comes under this gate on the commit that adds its catalog entry, which is the right moment.
 */
describe("every capability's config entry point loads outside workerd", () => {
  /** One row per package: the catalog name, the directory, and the specifier `pithy add` writes. */
  const entries = [...new Map(CATALOG.map((entry) => [entry.package, entry])).values()].map((entry) => ({
    name: entry.name,
    dir: join(PACKAGES, capabilityPackageDir(entry.name)),
    specifier: capabilityImportSpecifier(capabilityPackageName(entry.name)),
  }));

  test("every catalogued capability is covered, and its entry point exists", () => {
    // A list that silently emptied — or a package whose `src/index.ts` was never written, the
    // `@pithy-sh/secrets` failure `catalog.test.ts` guards from the other side — would make the
    // import test below a no-op that passes.
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.filter((entry) => !existsSync(join(entry.dir, "src", "index.ts")))).toEqual([]);
  });

  test("importing it in a Node process resolves", async () => {
    const failures = await Promise.all(
      entries.map(async (entry) => {
        try {
          await run("bun", ["-e", `await import(${JSON.stringify(entry.specifier)})`], { cwd: entry.dir });
          return undefined;
        } catch (error) {
          const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : String(error);
          return `${entry.name} — ${entry.specifier} does not import in Node: ${stderr.split("\n")[0]}`;
        }
      }),
    );

    expect(failures.filter((failure) => failure !== undefined)).toEqual([]);
  });
});

/**
 * The rule one step earlier: **a module that imports `cloudflare:workers` exports nothing a non-runtime
 * module could want.**
 *
 * The gate above performs the import and requires it to succeed, which is the strongest possible test of
 * the edges that exist. It is structurally blind to the edges that do not yet: an entry point that reaches
 * a Workers-only module fails there, and a Workers-only module that merely *offers* something to Node
 * passes, right up until somebody accepts the offer.
 *
 * That offer is what #172 and #180 were, twice. `@pithy-sh/multiplayer`'s routes imported two string
 * constants out of the Durable Object module, so a `pithy.config.ts` composing multiplayer dragged
 * `cloudflare:workers` into a plain Node process and died with `Could not load pithy.config.ts` — which
 * names the config, not the import. The reported cause was a missing package and the issue's own diagnosis
 * blamed the wrong file until somebody traced the edge. #180 was the identical arrangement in
 * `presence/durableObject.ts`, and a third was found and removed while fixing it.
 *
 * **So the invariant is stated about the module, not about a list of files.** Four sites were known when
 * this was written — `REFRESH_BATCH_CHUNKS`, `auditLogEmit`, `logReconcileReport`, `logPassComplete`,
 * `logCohortFailure` — and every defect class in this repository has had three or more producers, so
 * enumerating them is what produces the next one. What this asks instead is decidable from the module's
 * own text: a runtime module may export the classes it defines against a `cloudflare:workers` base and its
 * default handler, and nothing else. A type export is free — `verbatimModuleSyntax` erases an
 * `import type`, so a Node-side caller taking one takes no module with it.
 *
 * **The walk is `ci/sourceFiles.ts`** — the same one the rename, editor, follower and recursive-delete
 * tripwires read the tree through. Writing a seventh independent traversal to enforce a rule about not
 * repeating yourself would be its own joke (#185).
 *
 * It is a scan over source text, with the limits `atomic.test.ts` records: TypeScript 7 ships no parser
 * API, so there is no AST to walk. It reads import clauses and `export` declarations, so a class whose
 * base is aliased through another module, or a value assembled and exported by other means, would pass.
 * What it does see is every shape the four known instances took.
 */
describe("a module that imports cloudflare:workers exports nothing a non-runtime module could want", () => {
  /**
   * The runtime modules allowed to export something else: path → the exports it keeps, and why.
   *
   * Empty, and meant to stay that way. The answer to "a Node caller needs this constant" is a sibling
   * module with no runtime import — the shape `session/protocol.ts` (#172) and `presence/protocol.ts`
   * (#180) established. An entry here is a claim, and the test holds it to both halves: an undeclared
   * export fails, and a declared one that has since moved fails too, so the list cannot go stale.
   */
  const ALLOWED: Record<string, { exports: string; why: string }> = {};

  /** Source with its comments removed, so prose naming the module is not read as importing it. */
  function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  }

  /**
   * The names a module binds as *values* out of `cloudflare:workers`, or null if it never reaches it.
   *
   * Null and empty are different answers and the difference matters: a module with no runtime import is
   * not covered by this rule at all, while one that imports the runtime through a namespace binding, a
   * `require`, or a dynamic `import` is covered and has no base names this can read. Empty means every
   * value export is reported, which is the safe direction — it asks for a written reason rather than
   * assuming one.
   */
  function runtimeBases(text: string): Set<string> | null {
    const source = code(text);
    if (!/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']cloudflare:workers["']/.test(source)) return null;
    const bases = new Set<string>();
    for (const [, clause] of source.matchAll(/\bimport\s+\{([^}]*)\}\s+from\s+["']cloudflare:workers["']/g)) {
      for (const binding of (clause ?? "").split(",")) {
        const name = binding.trim();
        // A `type` binding erases, so it is never a base a class can extend at runtime.
        if (name.length === 0 || name.startsWith("type ")) continue;
        const exported = name.split(/\s+as\s+/)[0]?.trim();
        if (exported !== undefined && exported.length > 0) bases.add(exported);
      }
    }
    return bases;
  }

  /** What an `export` declaration names, or the declaration itself when it names nothing (`export *`). */
  function exportedName(declaration: string): string {
    const named = /^(?:abstract\s+|async\s+|declare\s+)*(?:const|let|var|function\*?|class|enum)\s+(\w+)/.exec(
      declaration,
    );
    return named?.[1] ?? declaration.replace(/\s+/g, " ").slice(0, 60);
  }

  /** Every value `source` exports that is not itself bound to the Workers runtime, in order. */
  function pureExports(text: string, bases: ReadonlySet<string>): string[] {
    const found: string[] = [];
    for (const [, tail] of code(text).matchAll(/^export\s+(.*)$/gm)) {
      const declaration = (tail ?? "").trim();
      // Types erase under `verbatimModuleSyntax`. Taking one drags no module across the boundary.
      if (/^(?:type|interface)\b/.test(declaration)) continue;
      // The worker's own handler. It is the deployment's entry point and reaches nothing else.
      if (declaration.startsWith("default")) continue;
      const declared = /^(?:abstract\s+)?class\s+\w+\s+extends\s+(\w+)/.exec(declaration);
      if (declared?.[1] !== undefined && bases.has(declared[1])) continue;
      found.push(exportedName(declaration));
    }
    return found;
  }

  /** Every runtime module in the tree: path under the repo root → the pure values it exports. */
  function runtimeModules(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const source of sourceFiles(REPO_ROOT)) {
      const bases = runtimeBases(source.text);
      if (bases === null) continue;
      found.set(relative(REPO_ROOT, source.path).split(sep).join("/"), pureExports(source.text, bases));
    }
    return found;
  }

  test("the walk finds the modules that cross into the Workers runtime at all", () => {
    // A scan that finds nothing passes the rule below it silently, and a rule nobody can see fail is the
    // muted tripwire this repository keeps rediscovering. So the walk is asserted before the rule is.
    const found = runtimeModules();
    expect(found.size).toBeGreaterThan(10);
    expect([...found.keys()]).toContain("packages/multiplayer/src/session/durableObject.ts");
    expect([...found.keys()]).toContain("packages/matchmaking/src/presence/durableObject.ts");
  });

  test("and prose naming the module is not mistaken for importing it", () => {
    // `multiplayer/src/index.ts` explains at length why the Durable Object is deliberately not exported
    // from it. A rule that fires on the explanation is a rule somebody deletes.
    expect([...runtimeModules().keys()]).not.toContain("packages/multiplayer/src/index.ts");
    expect([...runtimeModules().keys()]).not.toContain("packages/multiplayer/src/session/protocol.ts");
  });

  test("none of them exports a pure value", () => {
    const offering = Object.fromEntries(
      [...runtimeModules()].filter(([, pure]) => pure.length > 0).map(([path, pure]) => [path, pure.join(", ")]),
    );
    const declared = Object.fromEntries(Object.entries(ALLOWED).map(([path, { exports }]) => [path, exports]));

    // One equality, failing from both sides, and the received value names the module and what it offers.
    expect(
      offering,
      "move it to a sibling module with no runtime import, the way session/protocol.ts did (#172)",
    ).toEqual(declared);
  });

  test("and every runtime module that keeps one says why", () => {
    // A reason nobody wrote is a reason nobody reviewed, and this list is only worth having if adding to
    // it costs an argument. #172 cost real time because the edge was nobody's decision.
    for (const [path, { why }] of Object.entries(ALLOWED)) expect(why.trim().length, path).toBeGreaterThan(40);
  });
});
