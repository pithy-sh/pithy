// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { duplicatedKitPackages, kitCopies } from "./kitCopies";
import { isShippedSource, readSource, sourcePaths } from "./sourceFiles";

/**
 * **A `@pithy-sh/*` package another package imports is a `peerDependency` of it, never a `dependency` —
 * and the tree that comes out holds one copy of each.**
 *
 * The same rule `sharedRuntimeDeps.test.ts` states for `zod`, `kysely` and `hono`, applied to the kit's
 * own packages, which turn out to need it more (#542).
 *
 * ## What two copies cost, and the second one is not a type error
 *
 * **Compile time, `core`.** The 2026-09-10 release bumped eight packages to `core ^0.3.1`. Seven others
 * still declared `^0.3.0`, which *accepts* 0.3.1 — but a lockfile records resolutions and bun does not
 * move one it already holds. `pithy-sh/dashboard` ended with `auth`, `payments`, `email`, `audit`,
 * `support`, `testers` and `turnstile` on `core@0.3.0` while the app resolved `0.3.1`, and the build
 * failed 404 times naming APIs that exist:
 *
 * ```
 * apps/board/pithy.config.ts(149,58): error TS2339:
 *   Property 'enqueue' does not exist on type 'Capability<DatabaseSpecMap, KvNamespaceSpecMap, …>'.
 * ```
 *
 * **Runtime, `secrets`, and this one reaches an adopter's users.** `sharedSecretsStore.ts` holds
 * `let config: SharedConfig | null = null` at module scope. `configureSharedSecrets()` sets it on **the
 * instance the caller imported**; with two copies the `secrets` capability configures one and every reader
 * holds the other. Reproduced in the dashboard's dev server on 2026-09-10 — Google sign-in, a credential
 * that was present and well-formed:
 *
 * ```
 * POST /auth/sign-in/social  → 500
 * {"code":"core/internal","message":"The shared secrets accessor is not configured."}
 * ```
 *
 * It misattributes itself twice. The payload's `detail` says *"configureSharedSecrets was never called"*
 * and `clientError` strips `detail` — correctly; that is the security boundary — so the operator reads
 * *not configured* about a capability they did compose, and the dashboard renders it as *"Google didn't
 * answer"*, naming a service never contacted.
 *
 * **Nothing caught it.** Build green, every declared range satisfied, and
 * `node_modules/@pithy-sh/core/package.json` — the one file anybody checks — reporting the correct
 * version, because an isolated linker puts the wrong copies where nobody looks.
 *
 * ## Why re-releasing does not fix it and peers do
 *
 * Re-releasing the dependents is neither necessary (`^0.3.0` already accepts 0.3.1) nor sufficient (an
 * adopter's lockfile holding `auth@0.1.6` keeps its resolution whatever `auth@0.1.7` declares). And bun
 * offers no way out: measured on 1.3.14, `bun pm dedupe` does not exist, `bun update @pithy-sh/core` and
 * `bun update --force` both leave the split, and only `overrides` or deleting the lockfile work.
 *
 * A `dependency` is the kit saying *I need some copy of this*. A `peerDependency` is the kit saying *you
 * and I must share one*, which is the true statement and the one every package manager can act on: npm,
 * pnpm and bun install a peer once, at the top, where the adopter's own import finds it too. The split
 * stops being a resolution somebody has to notice and becomes unrepresentable.
 *
 * ## Derived from the imports, never listed
 *
 * A package that imports another kit package from shipped source declares it as a peer; one that does not,
 * does not. Both directions, because a list of pairs is a second thing to keep in step with the first —
 * and "peer everything, to be safe" would pass a one-directional gate while making every adopter install
 * a `@pithy-sh/cloudflare` for a Worker that never calls the REST API. It found two of those on the way
 * in: `@pithy-sh/audit` declared `@pithy-sh/cloudflare` and imports it from nowhere at all — four doc
 * comments, and `resolveActor` deliberately declares the slices it needs *structurally* so it does not
 * have to — and `@pithy-sh/vector` declared `@pithy-sh/cloudflare` (one integration test) and
 * `@pithy-sh/secrets` (nothing).
 *
 * **A type-only import counts.** It is the `core` case exactly: a `Capability` that crosses a seam is a
 * type before it is a value, `.d.ts` output names the package, and two copies are two types.
 *
 * ## `@pithy-sh/cli` is the one exemption, and it is about what a bin is
 *
 * The CLI keeps `dependencies`. Nothing composes it: no adopter writes `import … from "@pithy-sh/cli"`, no
 * `Capability` of its making crosses into a Worker, and its types appear in nobody's build. A peer exists
 * to force one shared copy between a library and the graph it is composed into, and the CLI is not in one.
 *
 * It is also the shape of the thing. `bunx @pithy-sh/cli init` runs in an empty directory — that is what
 * `kitResolution.test.ts`'s exemption for `commands/init.ts` says: *`pithy init` runs before the project
 * exists*. A peer there is unmet by construction, and a globally installed `pithy` has no adopter graph to
 * be hoisted into. Peering would make the CLI's behavior depend on how it was installed, which is worse
 * than the uniform residue it has now. That residue — the CLI reading its own `@pithy-sh/secrets`,
 * `email`, `turnstile` and `ui-react` while the adopter's Worker reads theirs — is a *resolution* defect
 * with its own issue (#533) and its own gate, and the fix named there is a project-based loader, not a
 * peer range.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The scope, and the two workspace groups whose members are published packages. */
const SCOPE = "@pithy-sh/";

/**
 * The one member that declares kit packages as `dependencies`, with the sentence to disagree with.
 *
 * Checked in both directions: a second entry here is a decision, and an entry whose package has stopped
 * declaring a kit dependency is deleted rather than left standing.
 */
const NOT_PEERED: Record<string, string> = {
  "packages/cli":
    "A bin, not a library. Nothing composes it, its types cross into no build, and `pithy init` runs " +
    "in a directory with no project to hoist a peer into.",
};

/**
 * The kit peers that are **optional**, and why each is a choice the consumer makes rather than a
 * requirement of the package.
 *
 * Every one is a *composed capability*: the package works without it and lights up an extra seam when it
 * is there. `peerDependenciesMeta.optional` is what says so, and it is also what `declareOnWorker` reads —
 * an optional peer is not written onto the Worker, because the adopter's own `pithy add` declares it on
 * their terms (`project/packageManager.ts`).
 *
 * Pinned as a set so nothing quietly marks a *required* peer optional. `@pithy-sh/core` optional would
 * hand every adopter back the split this file exists to close, silently, and the package would still
 * install.
 */
const OPTIONAL_PEERS: Record<string, string> = {
  "packages/matchmaking:@pithy-sh/auth": "Invites resolve against auth when it is composed.",
  "packages/matchmaking:@pithy-sh/rating": "Skill-based queueing reads ratings when rating is composed.",
  "packages/multiplayer:@pithy-sh/leaderboard": "Results publish to a leaderboard when one is composed.",
  "packages/multiplayer:@pithy-sh/ledger": "Game effects post to the ledger when it is composed.",
  "packages/payments:@pithy-sh/ledger": "Grants write through the ledger seam when the ledger is composed.",
  "packages/support:@pithy-sh/auth": "A magic link is sent through auth when auth is composed.",
  "packages/support:@pithy-sh/payments": "A ticket links to a subscription when payments is composed.",
  "packages/testers:@pithy-sh/auth": "Tester activity resolves against auth when auth is composed.",
};

/** Every workspace member under `packages/`, relative to the root, sorted. */
const MEMBERS = readdirSync(join(REPO_ROOT, "packages"))
  .map((name) => `packages/${name}`)
  .filter((path) => readSource(resolve(REPO_ROOT, path, "package.json")) !== null)
  .sort();

/** Every directory a `node_modules` may hang off: the root and each workspace member. */
function walkRoots(): string[] {
  const roots = [REPO_ROOT];
  for (const group of ["packages", "tooling", "apps"]) {
    let names: string[];
    try {
      names = readdirSync(join(REPO_ROOT, group));
    } catch {
      continue;
    }
    for (const name of names) roots.push(join(REPO_ROOT, group, name));
  }
  return roots;
}

/** The parts of a member's manifest this reads. */
interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  readonly devDependencies?: Record<string, string>;
}

/** One member's manifest. */
function manifest(directory: string): Manifest {
  return JSON.parse(readSource(resolve(REPO_ROOT, directory, "package.json")) ?? "{}") as Manifest;
}

/** `@pithy-sh/core` → `packages/core`, read from the manifest rather than assembled from the directory. */
const NAME_OF = new Map(MEMBERS.map((directory) => [manifest(directory).name ?? directory, directory]));

/** Every published version, by package name. */
function versionOf(name: string): string | undefined {
  const directory = NAME_OF.get(name);
  return directory === undefined ? undefined : manifest(directory).version;
}

/**
 * The kit packages `directory` imports from shipped source — value imports and type-only imports alike.
 *
 * A specifier inside a comment is prose; `blankComments` takes those out first, which is what keeps
 * `@pithy-sh/audit`'s four mentions of `@pithy-sh/cloudflare` from reading as four imports.
 */
function kitImports(directory: string): string[] {
  const found = new Set<string>();
  const self = manifest(directory).name;
  for (const path of sourcePaths(resolve(REPO_ROOT, directory, "src"), { keep: isShippedSource })) {
    const text = readSource(path);
    if (text === null) continue;
    for (const match of blankComments(text).matchAll(
      /(?:\bfrom|^\s*(?:import|export)|\bimport\s*\()\s*\(?\s*["'](@pithy-sh\/[^"']+)["']/gm,
    )) {
      const name = (match[1] as string).split("/").slice(0, 2).join("/");
      if (name !== self) found.add(name);
    }
  }
  return [...found].sort();
}

/** The kit entries of one dependency block. */
function kitEntries(block: Record<string, string> | undefined): string[] {
  return Object.keys(block ?? {})
    .filter((name) => name.startsWith(SCOPE) && name !== "@pithy-sh/tsconfig")
    .sort();
}

describe("a kit package another package imports is a peer of it", () => {
  // The vacuity floor. An empty member list, or a walk that stopped finding imports, satisfies every
  // assertion below without reading a manifest.
  test("there are members to check, and they do import each other", () => {
    expect(MEMBERS.length).toBeGreaterThan(15);
    expect(kitImports("packages/auth")).toContain("@pithy-sh/core");
    expect(kitImports("packages/turnstile")).toContain("@pithy-sh/secrets");
  });

  test("every kit package a member imports is declared as a peer, and one it does not import is not", () => {
    const faults: string[] = [];
    for (const directory of MEMBERS) {
      if (directory in NOT_PEERED) continue;
      const imported = kitImports(directory);
      const peers = kitEntries(manifest(directory).peerDependencies);
      for (const name of imported) {
        if (!peers.includes(name)) faults.push(`${directory} imports ${name} and does not peer it`);
      }
      for (const name of peers) {
        if (!imported.includes(name)) faults.push(`${directory} peers ${name} and imports it from no shipped source`);
      }
    }
    expect(faults).toEqual([]);
  });

  test("no member declares a kit package as a plain dependency, which is what would duplicate it", () => {
    const faults: string[] = [];
    for (const directory of MEMBERS) {
      if (directory in NOT_PEERED) continue;
      for (const name of kitEntries(manifest(directory).dependencies)) {
        faults.push(`${directory} declares ${name} as a dependency; it must be a peer`);
      }
    }
    expect(faults).toEqual([]);
  });

  test("the one exemption is real, and it is the only one", () => {
    for (const directory of Object.keys(NOT_PEERED)) {
      expect(MEMBERS, `${directory} is not a workspace member`).toContain(directory);
      expect(
        kitEntries(manifest(directory).dependencies).length,
        `${directory} no longer declares a kit dependency. Delete its entry from NOT_PEERED.`,
      ).toBeGreaterThan(0);
    }
    expect(Object.keys(NOT_PEERED)).toEqual(["packages/cli"]);
  });

  /**
   * **The range is `^` the version that package is at, and every declarer says the same thing.**
   *
   * Width is not what re-admits the split — a peer is installed once whatever its range says. *Disagreement*
   * is: two packages whose ranges have no version in common force an installer to satisfy both separately,
   * which is the duplication again with a lockfile that looks correct. So the property is agreement, and
   * the value they agree on is derived from the workspace rather than frozen here, because Changesets
   * rewrites these ranges on every release (`updateInternalDependencies: "patch"`) and a literal would be
   * wrong one release later. Caret rather than a pin because a patch of `core` must not need twenty
   * releases to reach an adopter; below 1.0 the caret's own floor at the minor is what keeps a breaking
   * change from arriving as an accepted range.
   */
  test("every kit peer range is the caret of that package's current version", () => {
    const faults: string[] = [];
    for (const directory of MEMBERS) {
      const peers = manifest(directory).peerDependencies ?? {};
      for (const name of kitEntries(peers)) {
        const version = versionOf(name);
        expect(version, `${name} is not a workspace member`).toBeDefined();
        if (peers[name] !== `^${version}`) {
          faults.push(`${directory} peers ${name}@${peers[name]}, not ^${version}`);
        }
      }
    }
    expect(faults).toEqual([]);
  });

  // A peer is not installed for the package that declares it, so without this the workspace could not
  // build or test itself — and the failure would arrive as a resolution error in an unrelated suite.
  test("every kit peer is a workspace devDependency too, so the package can build and test itself", () => {
    const faults: string[] = [];
    for (const directory of MEMBERS) {
      const dev = manifest(directory).devDependencies ?? {};
      for (const name of kitEntries(manifest(directory).peerDependencies)) {
        if (dev[name] !== "workspace:*") {
          faults.push(`${directory} peers ${name} and its devDependency is ${dev[name] ?? "missing"}`);
        }
      }
    }
    expect(faults).toEqual([]);
  });

  /**
   * Optional is for a composed capability and nothing else — pinned as a set, in both directions.
   *
   * A required peer marked optional installs cleanly and hands the adopter back the split. A composed
   * capability marked required makes `pithy add support` install `auth` and `payments` whether or not the
   * project wants them, and `declareOnWorker` writes both onto the Worker.
   */
  test("the optional kit peers are exactly the composed capabilities", () => {
    const found: string[] = [];
    for (const directory of MEMBERS) {
      const parsed = manifest(directory);
      for (const name of kitEntries(parsed.peerDependencies)) {
        if (parsed.peerDependenciesMeta?.[name]?.optional === true) found.push(`${directory}:${name}`);
      }
    }
    expect(found.sort()).toEqual(Object.keys(OPTIONAL_PEERS).sort());
  });

  // `core` is the one every capability composes against, so its polarity is asserted by name rather than
  // only as a member of the set above.
  test("core is a required peer of every package that imports it", () => {
    const importers = MEMBERS.filter(
      (directory) => !(directory in NOT_PEERED) && kitImports(directory).includes("@pithy-sh/core"),
    );
    expect(importers.length).toBeGreaterThan(15);
    for (const directory of importers) {
      const parsed = manifest(directory);
      expect(parsed.peerDependencies?.["@pithy-sh/core"], `${directory} does not peer core`).toBeDefined();
      expect(
        parsed.peerDependenciesMeta?.["@pithy-sh/core"]?.optional,
        `${directory} marks core optional, which makes the split installable again`,
      ).not.toBe(true);
    }
  });
});

/**
 * **The tripwire beside the rule: no `@pithy-sh/*` package resolves to two directories.**
 *
 * The manifests above are the fix; this reads what actually landed. A lockfile holding a resolution its
 * ranges no longer justify, an `overrides` line somebody removed, a package manager that hoisted
 * differently than the last one — none of those changes a manifest, and each produces the tree the
 * dashboard shipped. Cheap, and it fails here rather than in an adopter's Worker.
 *
 * `kitCopies` counts **directories through `realpath`**, so the many symlinks an isolated linker plants
 * are one copy, and two directories are two module instances whatever versions they carry.
 */
describe("the resolved tree holds one copy of each kit package", () => {
  const copies = kitCopies(walkRoots());

  // The floor, and it is the specific failure this walker had in draft: seeded with the repository root
  // alone it found four packages — bun's isolated linker puts in a root's `node_modules` only what that
  // root declares — and reported no duplicates, which is exactly the permanently-green answer the
  // dashboard's own version check gave.
  test("the walk found the kit, rather than reporting a tree it could not read", () => {
    expect(copies.size).toBeGreaterThan(15);
    expect(copies.get("@pithy-sh/core")?.[0]?.version).toBe(manifest("packages/core").version);
  });

  test("no package is installed twice", () => {
    expect(
      duplicatedKitPackages(copies),
      "Two copies of a kit package are two types and two module states. Declare it as a peerDependency " +
        "wherever it crosses a package boundary; if the declarations are already right, the lockfile is " +
        "holding a stale resolution. See #542.",
    ).toEqual([]);
  });
});

/**
 * **What `pithy init` scaffolds satisfies what it declares.**
 *
 * A peer is a requirement on the *consumer*, and the consumer of a kit package is the adopter's Worker.
 * `templates/starter/apps/api/package.json` is what `pithy init` writes it from — `stampWorkerManifest`
 * fixes up the name and core's range and touches nothing else — so that file is where the requirement is
 * either met or missed. 0.1.3 is the record of missing it: the scaffolded Worker declared its capabilities
 * and nothing declared their peers, and `@pithy-sh/core` failed to load with `ERR_MODULE_NOT_FOUND`.
 *
 * Derived from the workspace manifests, so the template cannot fall behind a package that gains a
 * requirement. **Only the required peers**: an optional one is a capability the adopter composes later,
 * through `pithy add`, which declares it and its peers then (`project/packageManager.ts`).
 *
 * Today this is a confirmation rather than a change — core's required peers are `hono`, `kysely` and
 * `zod`, which the template has always carried. It is here for the day one of them moves. And if `core`
 * ever gains a *kit* peer, this fails and the fix is not only the template: `stampWorkerManifest` rewrites
 * the range of exactly one `@pithy-sh/*` line, which `scaffold.test.ts` holds it to.
 */
describe("the Worker pithy init scaffolds declares what its kit packages require", () => {
  const template: Manifest = JSON.parse(
    readSource(join(REPO_ROOT, "templates", "starter", "apps", "api", "package.json")) ?? "{}",
  ) as Manifest;

  test("the template is there, and it declares the kit", () => {
    expect(kitEntries(template.dependencies)).toEqual(["@pithy-sh/core"]);
  });

  test("every required peer of every kit package it declares is declared beside it, at the same range", () => {
    const declared = template.dependencies ?? {};
    const faults: string[] = [];
    for (const name of kitEntries(declared)) {
      const directory = NAME_OF.get(name);
      expect(directory, `${name} is not a workspace member`).toBeDefined();
      const parsed = manifest(directory as string);
      for (const [peer, range] of Object.entries(parsed.peerDependencies ?? {})) {
        if (parsed.peerDependenciesMeta?.[peer]?.optional === true) continue;
        if (declared[peer] === undefined) {
          faults.push(`the starter Worker declares ${name} and not its required peer ${peer}@${range}`);
          continue;
        }
        // The kit's own ranges are stamped at scaffold time from the CLI's version, not copied from here.
        if (!peer.startsWith(SCOPE) && declared[peer] !== range) {
          faults.push(`the starter Worker declares ${peer}@${declared[peer]}, and ${name} requires ${range}`);
        }
      }
    }
    expect(faults).toEqual([]);
  });
});

describe("the import extractor", () => {
  test("core imports no kit package, which is what makes it the seam", () => {
    expect(kitImports("packages/core")).toEqual([]);
  });

  test("a type-only import counts, because two copies are two types", () => {
    expect(kitImports("packages/vite")).toContain("@pithy-sh/core");
  });
});
