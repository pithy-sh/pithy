// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createRequire } from "node:module";
import { join } from "node:path";
import { CATALOG } from "../capabilities/catalog";

/**
 * Whether this project resolves **one** `zod`, one `kysely` and one `hono`, or several.
 *
 * ## Why a health check earns its place here
 *
 * Two copies of a package whose classes carry private members are two *different types*, and TypeScript
 * says so in a way that names neither the package nor the duplication:
 *
 * ```
 * Type 'Kysely<any>' is not assignable to type 'Kysely<any>'.
 *   Property '#private' refers to a different member that cannot be accessed from within type.
 * ```
 *
 * ```
 * Type 'Handler<any, any, any, any>' is not assignable to type 'Handler<any, any, any, any>'.
 *   Property '[GET_MATCH_RESULT]' is missing in type 'HonoRequest<any, any>' but required in
 *   type 'HonoRequest<any, any>'.
 * ```
 *
 * Both sides read identically unless you compare them character by character, and nothing points at
 * `node_modules`. `pithy-sh/dashboard` lost a day to it on the day it moved off a linked checkout onto
 * published `0.1.2` (#477). Every kit package declares these three as `peerDependencies` now, so an
 * installer puts one at the top — but a peer is a request, not a guarantee: a range conflict, a
 * `--legacy-peer-deps`, a resolution an adopter pinned, or a workspace hoisting differently all
 * reintroduce the second copy. This is a question with a definite answer and a terrible error message,
 * which is exactly what `pithy doctor` is for.
 *
 * ## Resolution, not a directory walk
 *
 * The question is not "how many copies are on disk" — it is "do the kit and this project agree on
 * which one". So each root is *asked*, through node's own resolver, and the answers are compared. A
 * vendored copy nothing resolves is not a fault, and a single copy reached by two different paths is
 * not two copies. It also means this reads no directory: `sourceFiles.test.ts` fails any module that
 * hand-rolls a traversal, and there is nothing here to traverse.
 *
 * The roots are the project itself and every capability package the catalog names, because those are
 * the two sides that have to agree — the adopter's own `import { z } from "zod"` and the kit's.
 */

/** The three whose identity has to be shared. Kept beside `sharedRuntimeDeps.test.ts`, which peers them. */
export const SHARED_RUNTIMES = ["zod", "kysely", "hono"] as const;

/** One shared runtime, and where this project resolves it from. */
export interface SharedRuntimeResolution {
  /** The package name: `zod`, `kysely` or `hono`. */
  name: string;
  /**
   * Every distinct copy something in this project resolves, as the directory each lives in.
   *
   * One entry is healthy. Zero means nothing resolves it — not a fault: a project that composes no
   * capability needing it, or has not installed yet.
   */
  copies: string[];
}

/** What the check found. */
export interface SharedRuntimesCheck {
  /** One entry per shared runtime that anything resolved, in {@link SHARED_RUNTIMES} order. */
  resolutions: SharedRuntimeResolution[];
  /** The ones with more than one copy. Empty is healthy, and is the ordinary case. */
  duplicated: SharedRuntimeResolution[];
}

/** Everything the check reads, injectable so a unit test never needs a real `node_modules`. */
export interface SharedRuntimesOptions {
  projectDir: string;
  /**
   * Seam: where `name` resolves to, asked from `from`, or `null` when it does not resolve there.
   *
   * Defaults to node's own resolver. A test hands its own so the fixture is a table rather than a tree.
   */
  resolveFrom?: (from: string, name: string) => string | null;
}

/** The directory a resolved path belongs to, as the copy it came from. */
function copyDir(resolved: string, name: string): string {
  const marker = `node_modules/${name}`;
  const at = resolved.replace(/\\/g, "/").lastIndexOf(marker);
  return at === -1 ? resolved : resolved.slice(0, at + marker.length);
}

/** Node's own resolver, asked from a directory rather than from this module. */
function nodeResolve(from: string, name: string): string | null {
  try {
    return createRequire(join(from, "package.json")).resolve(name);
  } catch {
    return null;
  }
}

/**
 * How many copies of each shared runtime this project resolves.
 *
 * Never throws: a root that cannot be resolved from contributes nothing, which is the same answer as a
 * capability that is not installed.
 */
export function checkSharedRuntimes(options: SharedRuntimesOptions): SharedRuntimesCheck {
  const resolve = options.resolveFrom ?? nodeResolve;

  // The project, and every capability package it may have installed. A capability that is absent
  // resolves nothing and drops out on its own.
  const roots = [
    options.projectDir,
    ...CATALOG.map((entry) => join(options.projectDir, "node_modules", ...entry.package.split("/"))),
  ];

  const resolutions: SharedRuntimeResolution[] = [];
  for (const name of SHARED_RUNTIMES) {
    const copies = new Set<string>();
    for (const root of roots) {
      const resolved = resolve(root, name);
      if (resolved !== null) copies.add(copyDir(resolved, name));
    }
    if (copies.size > 0) resolutions.push({ name, copies: [...copies].sort() });
  }

  return { resolutions, duplicated: resolutions.filter((one) => one.copies.length > 1) };
}

/** The check as one sentence — the `--json` `detail`, and the line the report prints. */
export function describeSharedRuntimes(check: SharedRuntimesCheck): string {
  if (check.resolutions.length === 0) return "No shared runtime resolves yet.";
  if (check.duplicated.length === 0) {
    return `One copy each of ${check.resolutions.map((one) => one.name).join(", ")}.`;
  }
  const named = check.duplicated.map((one) => `${one.name} (${one.copies.length})`).join(", ");
  return `More than one copy of ${named}. Two copies are two types, and the compiler will not say so.`;
}
