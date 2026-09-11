// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { duplicatedKitPackages, kitCopies } from "./kitCopies";

/**
 * The walker behind `kitPeerDeps.test.ts`'s tripwire, on trees built here rather than on this repository's
 * own — which holds one copy of everything and so can never show that the check fires (#542).
 *
 * ## The layouts here were measured, not imagined
 *
 * The first draft of this file claimed the isolated-linker case and built the *hoisted* one —
 * `node_modules/@pithy-sh/auth/node_modules/@pithy-sh/core`, a nested directory no isolated linker
 * produces — so the gate shipped unable to see a duplicate in the exact tree its own docblock named. A
 * fixture shaped from an assumption proves the assumption.
 *
 * So each layout below is a transcription of a real install of the real published packages. A workspace
 * whose `apps/api` declares `@pithy-sh/core ^0.3.0` and `@pithy-sh/turnstile 0.1.5` (whose own dependency
 * is `@pithy-sh/core ^0.2.0`) puts two `core` directories on disk, and each package manager puts them
 * somewhere different:
 *
 * ```
 * bun 1.3.14, default (isolated) linker
 *   node_modules/.bun/@pithy-sh+core@0.2.0+f2f94bf0d8ae1a37/node_modules/@pithy-sh/core
 *   node_modules/.bun/@pithy-sh+core@0.3.1+f2f94bf0d8ae1a37/node_modules/@pithy-sh/core
 *   node_modules/.bun/@pithy-sh+turnstile@0.1.5+f2f94bf0d8ae1a37/node_modules/@pithy-sh/turnstile
 *   node_modules/.bun/@pithy-sh+turnstile@0.1.5+f2f94bf0d8ae1a37/node_modules/@pithy-sh/core  → the 0.2.0 entry
 *   apps/api/node_modules/@pithy-sh/core                                                      → the 0.3.1 entry
 *
 * pnpm 10.34.5 — the same shape under a different directory name
 *   node_modules/.pnpm/@pithy-sh+core@0.2.0_hono@4.13.7_kysely@0.29.5_zod@4.6.2/node_modules/@pithy-sh/core
 *
 * bun --linker=hoisted, and npm 11.19.1
 *   node_modules/@pithy-sh/core
 *   node_modules/@pithy-sh/turnstile/node_modules/@pithy-sh/core
 * ```
 *
 * The store entry's `node_modules` holds the package **and its dependencies as siblings**; the package
 * directory itself has no `node_modules` at all. That is the fact the walk turns on, and the reason it
 * queues the `node_modules` a package's real directory *sits in* rather than only the one under it.
 */

// Through `realpath`, because the walk reports real directories and `paths` below reads a copy's
// location relative to this one — on a platform whose temp directory is itself a link (`/tmp` →
// `/private/tmp`), the unresolved root is a prefix of nothing the walk returns.
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pithy-kit-copies-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** An installed package at `where`, relative to the root. Returns its absolute path. */
async function pkg(where: string, name: string, version: string): Promise<string> {
  const at = join(root, ...where.split("/"));
  await mkdir(at, { recursive: true });
  await writeFile(join(at, "package.json"), JSON.stringify({ name, version }));
  return at;
}

/** A symlink at `where`, relative to the root, pointing at `target`. */
async function link(where: string, target: string): Promise<void> {
  const at = join(root, ...where.split("/"));
  await mkdir(dirname(at), { recursive: true });
  await symlink(target, at);
}

/**
 * One entry of an isolated linker's store: `node_modules/<store>/<key>/node_modules/<name>` is the real
 * package, and `<key>` carries the peer context the linker resolved it under. Returns both the package
 * directory and the `node_modules` its dependencies are linked into beside it.
 */
async function storeEntry(
  store: string,
  key: string,
  name: string,
  version: string,
): Promise<{ readonly at: string; readonly deps: string }> {
  const where = `node_modules/${store}/${key}/node_modules`;
  return { at: await pkg(`${where}/${name}`, name, version), deps: where };
}

/** What the walk found, as `name@version` per copy. */
function seen(found: Map<string, { version: string }[]>): string[] {
  return [...found].flatMap(([name, copies]) => copies.map((copy) => `${name}@${copy.version}`)).sort();
}

/** Every copy's directory, as a path relative to the root. */
function paths(found: Map<string, { path: string }[]>, name: string): string[] {
  return (found.get(name) ?? []).map((copy) => copy.path.slice(root.length + 1)).sort();
}

describe("kitCopies", () => {
  test("finds the top-level copy", async () => {
    await pkg("node_modules/@pithy-sh/core", "@pithy-sh/core", "0.3.1");
    expect(seen(kitCopies([root]))).toEqual(["@pithy-sh/core@0.3.1"]);
    expect(duplicatedKitPackages(kitCopies([root]))).toEqual([]);
  });

  /**
   * **The dashboard's tree, transcribed from the install that reproduces it.**
   *
   * `apps/api/node_modules/@pithy-sh/core` reports `0.3.1` — the file the version check read, and the
   * reason the upgrade looked like it had landed — while `turnstile` imports the `0.2.0` sitting *beside*
   * it in its own store entry. Nothing links to that one from anywhere a walk from the top passes, and
   * `.../@pithy-sh/turnstile/node_modules` does not exist: a walker that looks only under a package
   * directory reads one `core`, reports no duplicates, and is green forever.
   */
  test("finds the copy an isolated linker puts beside a package, where nobody looks", async () => {
    const peers = "f2f94bf0d8ae1a37";
    const wanted = await storeEntry(".bun", `@pithy-sh+core@0.3.1+${peers}`, "@pithy-sh/core", "0.3.1");
    const stale = await storeEntry(".bun", `@pithy-sh+core@0.2.0+${peers}`, "@pithy-sh/core", "0.2.0");
    const turnstile = await storeEntry(".bun", `@pithy-sh+turnstile@0.1.5+${peers}`, "@pithy-sh/turnstile", "0.1.5");
    await link(`${turnstile.deps}/@pithy-sh/core`, stale.at);
    await link("apps/api/node_modules/@pithy-sh/core", wanted.at);
    await link("apps/api/node_modules/@pithy-sh/turnstile", turnstile.at);

    const found = kitCopies([root, join(root, "apps", "api")]);
    expect(seen(found)).toEqual(["@pithy-sh/core@0.2.0", "@pithy-sh/core@0.3.1", "@pithy-sh/turnstile@0.1.5"]);
    expect(duplicatedKitPackages(found)).toHaveLength(1);
    expect(duplicatedKitPackages(found)[0]).toContain("@pithy-sh/core");
    expect(duplicatedKitPackages(found)[0]).toContain("0.2.0");
    expect(duplicatedKitPackages(found)[0]).toContain("0.3.1");
  });

  /**
   * pnpm's store is the same shape under a different name, and the walk knows neither name. It queues the
   * `node_modules` a package's real directory sits in, which is Node's own resolution rule for an
   * installed package — so a linker nobody has heard of yet is covered by the same line.
   */
  test("pnpm's store is the same shape, and nothing here knows its name", async () => {
    const context = "_hono@4.13.7_kysely@0.29.5_zod@4.6.2";
    const wanted = await storeEntry(".pnpm", `@pithy-sh+core@0.3.1${context}`, "@pithy-sh/core", "0.3.1");
    const stale = await storeEntry(".pnpm", `@pithy-sh+core@0.2.0${context}`, "@pithy-sh/core", "0.2.0");
    const turnstile = await storeEntry(".pnpm", `@pithy-sh+turnstile@0.1.5${context}`, "@pithy-sh/turnstile", "0.1.5");
    await link(`${turnstile.deps}/@pithy-sh/core`, stale.at);
    await link("apps/api/node_modules/@pithy-sh/core", wanted.at);
    await link("apps/api/node_modules/@pithy-sh/turnstile", turnstile.at);

    const found = kitCopies([root, join(root, "apps", "api")]);
    expect(seen(found)).toEqual(["@pithy-sh/core@0.2.0", "@pithy-sh/core@0.3.1", "@pithy-sh/turnstile@0.1.5"]);
    expect(duplicatedKitPackages(found)).toHaveLength(1);
  });

  /**
   * **The split survives the peer change, and it arrives at one version.**
   *
   * With every kit range agreed and every kit dependency already a `peerDependency`, one dependent pinning
   * `hono` is enough: bun keys a store entry on the package *and the peers it resolved under*, so
   * `@pithy-sh/core@0.3.1` becomes `+de3bb4309bc01957` and `+ee7dc588ff51c349` — measured, with
   * `@pithy-sh/secrets@0.1.7` splitting beside it, which is two `sharedSecretsStore` module states and the
   * 500 the dashboard served. Two directories, one version, and every manifest correct.
   */
  test("a forked peer context is two copies at one version", async () => {
    for (const [app, peers] of [
      ["a", "de3bb4309bc01957"],
      ["b", "ee7dc588ff51c349"],
    ]) {
      const core = await storeEntry(".bun", `@pithy-sh+core@0.3.1+${peers}`, "@pithy-sh/core", "0.3.1");
      const secrets = await storeEntry(".bun", `@pithy-sh+secrets@0.1.7+${peers}`, "@pithy-sh/secrets", "0.1.7");
      const turnstile = await storeEntry(".bun", `@pithy-sh+turnstile@0.1.7+${peers}`, "@pithy-sh/turnstile", "0.1.7");
      await link(`${turnstile.deps}/@pithy-sh/core`, core.at);
      await link(`${turnstile.deps}/@pithy-sh/secrets`, secrets.at);
      await link(`apps/${app}/node_modules/@pithy-sh/turnstile`, turnstile.at);
    }

    const found = kitCopies([root, join(root, "apps", "a"), join(root, "apps", "b")]);
    expect(paths(found, "@pithy-sh/core")).toEqual([
      "node_modules/.bun/@pithy-sh+core@0.3.1+de3bb4309bc01957/node_modules/@pithy-sh/core",
      "node_modules/.bun/@pithy-sh+core@0.3.1+ee7dc588ff51c349/node_modules/@pithy-sh/core",
    ]);
    expect(duplicatedKitPackages(found)).toHaveLength(3);
    expect(duplicatedKitPackages(found).join("\n")).toContain("@pithy-sh/secrets: 0.1.7 at ");
  });

  /**
   * The hoisted layout, which bun writes under `--linker=hoisted` and npm 11 writes by default: a version
   * that could not be hoisted lands *under* the package that needs it. The other half of the same rule —
   * a package's dependencies resolve from the nearest `node_modules` at or above it, and here that is the
   * one beneath the dependent.
   */
  test("finds the nested copy a hoisted linker puts under the dependent", async () => {
    await pkg("node_modules/@pithy-sh/core", "@pithy-sh/core", "0.3.1");
    await pkg("node_modules/@pithy-sh/turnstile", "@pithy-sh/turnstile", "0.1.5");
    await pkg("node_modules/@pithy-sh/turnstile/node_modules/@pithy-sh/core", "@pithy-sh/core", "0.2.0");

    const found = kitCopies([root]);
    expect(seen(found)).toEqual(["@pithy-sh/core@0.2.0", "@pithy-sh/core@0.3.1", "@pithy-sh/turnstile@0.1.5"]);
    expect(duplicatedKitPackages(found)).toHaveLength(1);
  });

  // Two copies at one version are still two module instances, and `sharedSecretsStore`'s `config` is
  // `null` in the second one however the manifests read. Version is not identity; the directory is.
  test("two copies at the same version are two copies", async () => {
    await pkg("node_modules/@pithy-sh/secrets", "@pithy-sh/secrets", "0.1.6");
    await pkg("node_modules/@pithy-sh/auth/node_modules/@pithy-sh/secrets", "@pithy-sh/secrets", "0.1.6");
    expect(duplicatedKitPackages(kitCopies([root]))).toHaveLength(1);
  });

  // Bun's isolated linker and pnpm's store reach one real directory through many links. Counting links
  // would fail every correctly installed project.
  test("many symlinks to one directory are one copy", async () => {
    const real = await pkg("packages/core", "@pithy-sh/core", "0.3.1");
    for (const at of ["node_modules/@pithy-sh", "packages/auth/node_modules/@pithy-sh"]) {
      await mkdir(join(root, ...at.split("/")), { recursive: true });
      await symlink(real, join(root, ...at.split("/"), "core"));
    }
    await pkg("packages/auth", "@pithy-sh/auth", "0.1.6");

    const found = kitCopies([root, join(root, "packages", "auth")]);
    expect(found.get("@pithy-sh/core")).toHaveLength(1);
    expect(duplicatedKitPackages(found)).toEqual([]);
  });

  /**
   * **A workspace member is both a root and a package, and it is still a copy.**
   *
   * The draft dropped exactly this. `seen` was doing two jobs — deciding what to queue and deciding what
   * to record — so a member seeded as a root was already in it by the time the link to it turned up under
   * another member's `node_modules`, and the walk reported **zero** kit packages across this whole
   * repository while every assertion about duplicates passed. A gate that reads nothing is green forever.
   */
  test("a member seeded as a root is still recorded when a link reaches it", async () => {
    const real = await pkg("packages/core", "@pithy-sh/core", "0.3.1");
    await pkg("packages/auth", "@pithy-sh/auth", "0.1.6");
    await mkdir(join(root, "packages", "auth", "node_modules", "@pithy-sh"), { recursive: true });
    await symlink(real, join(root, "packages", "auth", "node_modules", "@pithy-sh", "core"));

    const found = kitCopies([root, join(root, "packages", "core"), join(root, "packages", "auth")]);
    expect(seen(found)).toEqual(["@pithy-sh/core@0.3.1"]);
  });

  /**
   * The seeding rule, asserted as the failure it was. Bun puts in a root's `node_modules` exactly what
   * that root declares, so a member's own dependencies hang off the member — and a walk from the
   * repository root alone reports a clean tree it never read.
   */
  test("a member's own node_modules is only reached when the member is a root", async () => {
    await pkg("packages/auth", "@pithy-sh/auth", "0.1.6");
    await pkg("packages/auth/node_modules/@pithy-sh/core", "@pithy-sh/core", "0.3.0");

    expect(seen(kitCopies([root]))).toEqual([]);
    expect(seen(kitCopies([root, join(root, "packages", "auth")]))).toEqual(["@pithy-sh/core@0.3.0"]);
  });

  test("a package outside the scope is not counted, however deep", async () => {
    await pkg("node_modules/zod", "zod", "4.4.0");
    await pkg("node_modules/hono/node_modules/zod", "zod", "3.0.0");
    expect(seen(kitCopies([root]))).toEqual([]);
  });

  // `.bin`, `.cache`, and the isolated stores are the linker's bookkeeping, never entered by name. The
  // store holds the real directories, which are reached through the links that point at them.
  test("the linker's own dotted bookkeeping is not a package", async () => {
    await pkg("node_modules/.bin/@pithy-sh/core", "@pithy-sh/core", "9.9.9");
    await pkg("node_modules/.bun/@pithy-sh+core@8.8.8+abc/node_modules/@pithy-sh/core", "@pithy-sh/core", "8.8.8");
    await pkg("node_modules/@pithy-sh/core", "@pithy-sh/core", "0.3.1");
    expect(seen(kitCopies([root]))).toEqual(["@pithy-sh/core@0.3.1"]);
  });

  // A manifest naming something else is a directory that happens to sit at that path — a half-finished
  // remove, a stray folder. It is not an installed copy, and reporting it as one is a false duplicate.
  test("a directory whose manifest names another package is not a copy of this one", async () => {
    await pkg("node_modules/@pithy-sh/core", "@pithy-sh/leftovers", "0.0.1");
    expect(seen(kitCopies([root]))).toEqual([]);
  });

  test("a root that is not there contributes nothing rather than throwing", () => {
    expect(seen(kitCopies([join(root, "gone")]))).toEqual([]);
  });
});
