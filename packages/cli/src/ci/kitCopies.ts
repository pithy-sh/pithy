// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * **How many copies of each `@pithy-sh/*` package a resolved tree actually holds.**
 *
 * `node_modules/@pithy-sh/core/package.json` reports one version, and that is the file everybody checks.
 * It is not the question. Under an isolated linker every package resolves its dependencies from a
 * `node_modules` of its own, so the copy that `@pithy-sh/turnstile` imports is a second directory that
 * nothing at the top links to. `pithy-sh/dashboard` upgraded to the 2026-09-10 release, read `0.3.1` at
 * the top, believed the upgrade had landed, and was running seven capabilities against `0.3.0` — 202 type
 * errors naming `Property 'enqueue' does not exist on type 'Capability<…>'`, on a property present in
 * both (#542).
 *
 * The `peerDependencies` in every capability's manifest are what make that unrepresentable. This is the
 * tripwire beside them: it reads the tree rather than the declarations, so it also catches the cases a
 * manifest cannot state — a lockfile holding a resolution the ranges no longer justify, an `overrides`
 * line somebody removed, a package manager that hoisted differently than the last one did.
 *
 * ## A copy is a real directory, not a name
 *
 * Identity is `realpath`, because under bun's isolated linker and pnpm's store almost every entry under
 * `node_modules` is a symlink into one real directory — `node_modules/@pithy-sh/core` →
 * `packages/core` in this workspace, `node_modules/.bun/@pithy-sh+core@0.3.1+<peers>/node_modules/…` in
 * an adopter's. Ten links to one directory are one module instance and must read as one; two directories
 * are two, whatever versions they carry. **Two copies at the same version still count as two**, which is
 * deliberate and is not a corner: bun keys a store entry on the package *and its peer context*, so one
 * dependent pinning `hono` splits `@pithy-sh/core@0.3.1` into
 * `@pithy-sh+core@0.3.1+de3bb4309bc01957` and `@pithy-sh+core@0.3.1+ee7dc588ff51c349` with every declared
 * range agreed and every kit dependency already a peer. Module state is per instance, so
 * `sharedSecretsStore`'s `config` is `null` in the second one regardless of what its `package.json` says.
 * Nothing here compares versions; the path is the key, start to finish.
 *
 * ## The walk descends where a package's dependencies actually resolve
 *
 * A queue of `node_modules` directories, never a recursive listing — a full walk of a monorepo's
 * dependencies is tens of thousands of files to answer a question about twenty-two directories. Each
 * root contributes its own `node_modules`, and from every package found the walk queues **both places
 * Node would look for that package's dependencies**:
 *
 * - `<package>/node_modules`, where npm and a hoisted linker put a version it could not hoist; and
 * - **the `node_modules` that *contains* the package's real directory**, which is where every isolated
 *   linker puts them. `node_modules/.bun/@pithy-sh+turnstile@0.1.5+<peers>/node_modules/@pithy-sh/core`
 *   is a *sibling* of the turnstile directory, not a child of it — measured on bun 1.3.14, and pnpm's
 *   `.pnpm` is the same shape with a different directory name.
 *
 * The second is the general rule and not a patch for two linkers: Node resolves a package's imports from
 * the nearest `node_modules` at or above it, and for an installed package that is the one it sits in.
 * Under a hoisted layout it is the directory the walk is already scanning, so it costs nothing and adds
 * nothing; under an isolated one it is the only way in. Reading it off the *realpath* rather than the
 * link is what makes it work, because the link is at the top and the dependencies are in the store.
 *
 * Nothing needs to know that `.bun` or `.pnpm` exist, and the walk still never enters a dotted entry:
 * those are the linker's bookkeeping, and the store directories inside them are reached through the
 * links that point at them.
 *
 * A directory that cannot be listed and a manifest that cannot be parsed are both skipped rather than
 * fatal: this runs over a tree an installer may be writing, and a file that is not there is not a copy.
 */

/** One resolved copy of a package: where it really is, and what it says it is. */
export interface KitCopy {
  /** The package's own directory, through `realpath` — the module instance's identity. */
  readonly path: string;
  /** The version its manifest declares, or `"unknown"` when it could not be read. */
  readonly version: string;
}

/** The scope this asks about. */
const SCOPE = "@pithy-sh";

/** `path`'s manifest `version`, or null when there is no readable manifest naming `expected`. */
function versionAt(path: string, expected: string): string | null {
  let parsed: { name?: unknown; version?: unknown };
  try {
    parsed = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.name !== expected) return null;
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

/** Every entry in `directory`, or nothing when it is not there. */
function entries(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** `path` through `realpath`, or null when it does not resolve. */
function resolved(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The `node_modules` a package installed at `path` resolves its own dependencies from, or null when
 * `path` does not sit in one.
 *
 * An installed package directory is `<node_modules>/<name>` or `<node_modules>/@scope/<name>`, so the
 * answer is one or two levels up and nowhere else. A workspace member reached through a link answers
 * null — `packages/core` sits in `packages`, and its dependencies come from the roots the caller passed.
 */
function containingModules(path: string): string | null {
  const parent = dirname(path);
  if (basename(parent) === "node_modules") return parent;
  const grandparent = dirname(parent);
  if (basename(parent).startsWith("@") && basename(grandparent) === "node_modules") return grandparent;
  return null;
}

/**
 * Every `@pithy-sh/*` copy reachable from `roots`, keyed by package name, each list sorted by path.
 *
 * A root is a directory that may hold a `node_modules` — a project root, a workspace member, an installed
 * package. From each one the walk reaches every `node_modules` a package chain leads to.
 *
 * **Every workspace member is its own root, and that is not a detail.** Bun's isolated linker puts in a
 * root's `node_modules` exactly what that root declares: this repository's own top-level `node_modules`
 * holds four entries, and `packages/auth/node_modules/@pithy-sh/` holds six that nothing above it links
 * to. A walk from the repository root alone reads four packages and reports no duplicates, which is the
 * same permanently-green answer the dashboard's version check gave. So the caller hands over the members
 * — `packages/*`, `apps/*` — and an adopter's project is the same shape, one Worker per `apps/<name>`.
 */
export function kitCopies(roots: readonly string[]): Map<string, KitCopy[]> {
  const found = new Map<string, Map<string, string>>();
  const scanned = new Set<string>();
  const pending: string[] = [];

  /** Queue a `node_modules` directory, once, by the real directory it names. */
  function queue(directory: string | null): void {
    if (directory === null) return;
    const at = resolved(directory);
    if (at === null || scanned.has(at)) return;
    scanned.add(at);
    pending.push(at);
  }

  for (const root of roots) queue(join(root, "node_modules"));

  while (pending.length > 0) {
    const modules = pending.pop() as string;
    for (const entry of entries(modules)) {
      // `.bin`, `.cache`, `.bun`, `.pnpm` — the linker's own bookkeeping, not packages. The store
      // directories under them are reached through the links that point at them, which is what carries
      // the peer context bun encodes in a store entry's name.
      if (entry.startsWith(".")) continue;
      const members = entry.startsWith("@") ? entries(join(modules, entry)).map((name) => `${entry}/${name}`) : [entry];
      for (const member of members) {
        const at = resolved(join(modules, ...member.split("/")));
        if (at === null) continue;
        // Recorded on every sighting, never behind the queue guard: `scanned` decides which directories
        // are *listed*, and a workspace member's real directory is reached from several of them.
        if (member.startsWith(`${SCOPE}/`)) {
          const version = versionAt(at, member);
          if (version !== null) {
            const copies = found.get(member) ?? new Map<string, string>();
            copies.set(at, version);
            found.set(member, copies);
          }
        }
        // Both places this package's own dependencies can be: nested under it (hoisted), and beside it
        // in the `node_modules` its real directory sits in (isolated). `realpath` first, so the store
        // entry is what gets read rather than the link at the top.
        queue(join(at, "node_modules"));
        queue(containingModules(at));
      }
    }
  }

  return new Map(
    [...found]
      .map(
        ([name, copies]) =>
          [
            name,
            [...copies]
              .map(([path, version]) => ({ path, version }))
              .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
          ] as const,
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The names {@link kitCopies} found more than one copy of, rendered one finding per line. */
export function duplicatedKitPackages(copies: Map<string, KitCopy[]>): string[] {
  return [...copies]
    .filter(([, found]) => found.length > 1)
    .map(([name, found]) => `${name}: ${found.map((copy) => `${copy.version} at ${copy.path}`).join("  |  ")}`);
}
