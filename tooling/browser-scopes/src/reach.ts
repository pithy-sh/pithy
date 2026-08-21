// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readSource } from "@pithy-sh/cli/src/ci/sourceFiles";

/**
 * What a module reaches, and whether any of it needs the Workers runtime.
 *
 * **The half `tsc` cannot see.** The DOM-only programs beside this file catch a reached module that
 * names a Workers global *badly* — bare, off the global scope, the way `@pithy-sh/auth`'s table map did
 * in #419. They say nothing about a reached module that names one **correctly**, because
 * `import type { D1Database } from "@cloudflare/workers-types"` compiles anywhere. That module is still
 * the server data layer, and a response schema that reaches it is still one careless line away from the
 * error the adopter reported — which is exactly what `@pithy-sh/secrets` was when this was written: its
 * response schemas reached `core/src/data/db.ts` through a type-only import of a Kysely reader, compiled
 * green, and would have gone red the day anything in that subtree dropped an import.
 *
 * ## One invariant, not a count of spellings (Jim, 2026-08-21)
 *
 * This file used to finish that thought like so: *"the two halves together are the rule: a module a
 * browser may import reaches no module that needs the Workers runtime, in either spelling. `tsc` owns
 * the bare one, this owns the explicit one."* Every clause of that is still true except the count, and a
 * rule stated as a count of spellings is a rule that shuts the moment somebody finds the next one.
 *
 * Somebody did. `/// <reference types="@cloudflare/workers-types" />` defeated both halves at once: the
 * specifier regex never matched a directive, and **`tsc` honours a reference directive whatever
 * `types: []` says**. A module carrying that line, with a bare `D1Database` under it, compiled clean in
 * the DOM-only program and drew no line from the walk. The option `tsconfig.responses.json` calls
 * load-bearing is not load-bearing against a module that brings its own ambient types.
 *
 * So the split is by *what a program can refuse*, which is a property rather than a list:
 *
 * - **`tsc` under `types: []` owns everything that fails in a browser's ambient environment.** A bare
 *   `D1Database`; the stricter `BufferSource` the DOM spells. Hand it the browser's types and it finds
 *   what a browser build would find.
 * - **This walk owns everything a program cannot refuse, cannot read as a fault, or never got to look
 *   at.** A named import of the Workers types, which compiles anywhere. A reference directive, which
 *   `types: []` cannot turn off. An edge that will not resolve, which is a subtree nobody checked.
 *
 * Whatever turns up fourth is the walk's if it changes what a program *has*, and `tsc`'s if it fails
 * under what a program *lacks*. That sentence is the rule. The bullets are today's instances of it.
 *
 * **Type-only edges count.** They cost a browser nothing at runtime and everything at compile time —
 * #419 was a type error, not a bundle. An edge the compiler follows is an edge. This is also why the
 * walk sees what `coverage.test.ts`'s "imports only types" assertion cannot, and why pointing it at the
 * scope modules turns four of them red (#430).
 *
 * **An edge that will not resolve is a fault, not a shrug (Jim, 2026-08-21).** {@link resolveSpecifier}
 * tried `${base}.ts` and `${base}/index.ts` and discarded everything else in silence — including
 * `../link/sender.js`, a spelling TypeScript's Bundler resolution follows to the `.ts` beside it. One
 * re-export written that way re-attached the whole #419 chain with both halves of the gate green.
 * Teaching the resolver the `.js` family is the small half of the answer. The large half is that a
 * specifier naming something *in this repository* now throws when nothing answers it, because a walk
 * that drops an edge it does not understand reports a clean graph it never walked. `zod` and `hono`
 * still resolve to nothing on purpose — `node_modules` is neither ours to fix nor part of the chain #419
 * came through — but that is now a case the walk decides rather than a hole it falls into.
 *
 * Kept here rather than in the test file because two suites will use it once #430 lands, and because a
 * walk over the repository is the kind of thing #185 taught this repo to write exactly once. Its errors
 * are plain `Error`s: this is build-time tooling in the class `packages/cli/src/ci/fileModes.ts`
 * describes, not the shipped runtime that owes a `PithyError`.
 */

/**
 * An import specifier, from a statement rather than from prose.
 *
 * Anchored to the start of a line, which is what keeps a doc comment out: every comment line in this
 * repository is ` * …`, so `^\s*import` cannot reach one. The three alternatives are the three forms
 * that exist here — `import …from "x"` and `export …from "x"`, the side-effect `import "x"`, and the
 * dynamic `import("x")`, which `link/sender.ts` uses for its optional capabilities and which the
 * compiler follows exactly as it follows the others.
 */
const SPECIFIER = /^\s*(?:import|export)\b[^;]*?from\s*"([^"]+)"|^\s*import\s*"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/gm;

/**
 * A triple-slash reference directive, of any kind.
 *
 * **Of any kind, deliberately.** The one that mattered named `@cloudflare/workers-types`, but the fault
 * is not which types it names. It is that a directive *injects* them into every program that reaches the
 * module, past the `types: []` that exists to say no — so a rule written against this one package name
 * would be the count-of-spellings mistake again, one layer down. `vite/client` in a kit module is the
 * same fault in a browser's clothes. No module a browser may import gets to widen the ambient
 * environment of the program importing it, so the walk asks whether there is a directive and not what it
 * says.
 *
 * Anchored to the start of a line, which is also what keeps `@pithy-sh/vite`'s `PREAMBLE` out: that is a
 * directive inside a template literal, text the module emits rather than a directive the module carries.
 * The `.d.ts` files that legitimately carry one — every capability's `src/cloudflare-test.d.ts` — are
 * never reached, because a declaration file is not what an import specifier resolves to.
 */
const REFERENCE = /^\s*\/\/\/\s*<reference\b/m;

/** `@pithy-sh/<package>/<path>` — the only cross-package form this repository writes. No barrels. */
const WORKSPACE = /^@pithy-sh\/([a-z-]+)\/(.+)$/;

/** The marker for "this module needs the Workers runtime", in its correct spelling. */
export const WORKERS_TYPES = "@cloudflare/workers-types";

/**
 * The suffix a specifier wears when it is written for the runtime rather than for the compiler.
 *
 * TypeScript source under Bundler resolution may name either the file or the file it will become, and
 * the compiler follows both. This repository writes the extensionless form today; `.js` is the one the
 * re-check of #419 found the walk blind to, and the rest of the family is here because leaving them out
 * would be the same list one entry longer.
 */
const EMITTED = /\.(?:js|jsx|mjs|cjs)$/;

/** One path from a root module to a module the walk will not clear, repo-relative. */
export type Trail = readonly string[];

/** A module the walk will not clear, and the trail that reaches it. */
export interface Reach {
  /** From the root to the offending module, repo-relative. */
  readonly trail: Trail;
  /** What that module does. One clause, rendered after the trail. */
  readonly why: string;
}

/** One line for an assertion to print: the trail, then the reason it ends there. */
export function describeReach(reach: Reach): string {
  return `${reach.trail.join(" -> ")} (${reach.why})`;
}

/**
 * A specifier that names something inside this repository, and so has to resolve to a file in it.
 *
 * The two forms are the two this repository writes: a relative path, and `@pithy-sh/…`. Everything else
 * is `node_modules`. A `@pithy-sh/…` specifier {@link WORKSPACE} cannot parse is internal *and*
 * unresolved, which is the throw below rather than a shrug — a barrel import is not a form this
 * repository writes, so one appearing is a thing to look at rather than a thing to skip.
 */
function isInternal(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("@pithy-sh/");
}

/**
 * The file a specifier names, or null when it leaves this repository.
 *
 * A bare `zod` or `hono` resolves to nothing on purpose: the question is what *kit* modules a kit module
 * pulls in, and `node_modules` is neither ours to fix nor part of the chain #419 came through. A
 * specifier that does name something here and resolves to nothing throws instead, because the
 * alternative — the one this had — is the silent drop that let a `.js` re-export carry the whole #419
 * chain past both halves of this gate.
 */
function resolveSpecifier(packages: string, from: string, specifier: string): string | null {
  if (!isInternal(specifier)) return null;
  const workspace = WORKSPACE.exec(specifier);
  const base = workspace
    ? join(packages, workspace[1] as string, workspace[2] as string)
    : specifier.startsWith(".")
      ? join(dirname(from), specifier)
      : null;
  if (base !== null) {
    const stem = base.replace(EMITTED, "");
    const candidates = [`${stem}.ts`, `${stem}.tsx`, join(stem, "index.ts"), join(stem, "index.tsx")];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `${relative(packages, from)} imports "${specifier}", and tooling/browser-scopes cannot resolve it. ` +
      "An edge the walk cannot follow is a subtree it cannot clear, so it stops rather than report a graph it did not walk.",
  );
}

/** Every specifier `text` imports, in source order, with the regex's three capture groups flattened. */
function specifiers(text: string): string[] {
  return [...text.matchAll(SPECIFIER)].map(([, a, b, c]) => (a ?? b ?? c) as string);
}

/**
 * `path`'s text, or a throw.
 *
 * `sourceFiles.ts` tolerates a file that vanished between the listing and the read, and is right to: it
 * sweeps a tree other suites scaffold into and delete out of (#185). Nothing here is that tree. Every
 * path but the root was proved by `existsSync` one statement before it was queued, so a read that fails
 * is an anomaly, and an anomaly this walk cannot report a clean answer over.
 */
function read(packages: string, path: string): string {
  const text = readSource(path);
  if (text !== null) return text;
  throw new Error(
    `tooling/browser-scopes cannot read ${relative(packages, path)}, so it cannot clear what that module reaches.`,
  );
}

/**
 * Every module `root` reaches that the walk will not clear, as the trail that reaches it.
 *
 * Breadth-first, so a trail is the shortest path to the offender and reads as an explanation rather than
 * as a walk. Each module is visited once — a second route to a module already reported adds a line
 * nobody acts on differently.
 *
 * Paths are relative to `packages`, which is what makes an assertion failure a diff of the chain the
 * issue quotes rather than of forty absolute paths.
 */
export function reachesWorkersRuntime(packages: string, root: string): Reach[] {
  const found: Reach[] = [];
  const trail = new Map<string, string[]>([[root, [relative(packages, root)]]]);
  const queue: string[] = [root];

  for (let at = 0; at < queue.length; at += 1) {
    const file = queue[at] as string;
    const text = read(packages, file);
    const here = trail.get(file) as string[];
    if (REFERENCE.test(text)) found.push({ trail: here, why: "carries a triple-slash reference directive" });
    for (const specifier of specifiers(text)) {
      if (specifier === WORKERS_TYPES || specifier.startsWith(`${WORKERS_TYPES}/`)) {
        found.push({ trail: here, why: `imports ${specifier}` });
        continue;
      }
      const next = resolveSpecifier(packages, file, specifier);
      if (next === null || trail.has(next)) continue;
      trail.set(next, [...here, relative(packages, next)]);
      queue.push(next);
    }
  }

  // One line per fault, deduplicated: a file importing the Workers types twice is one fault.
  return [...new Map(found.map((one) => [describeReach(one), one])).values()];
}

/** How many kit modules `root` reaches, itself included. The vacuity floor for {@link reachesWorkersRuntime}. */
export function reachCount(packages: string, root: string): number {
  const seen = new Set<string>([root]);
  const queue: string[] = [root];
  for (let at = 0; at < queue.length; at += 1) {
    const file = queue[at] as string;
    for (const specifier of specifiers(read(packages, file))) {
      const next = resolveSpecifier(packages, file, specifier);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size;
}
