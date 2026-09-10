// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  alreadyProvided,
  declareOnWorker,
  detectPackageManager,
  execArgs,
  installArgs,
  installPackage,
  promoteDependencies,
  uninstallArgs,
  uninstallPackage,
} from "./packageManager";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-pm-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectPackageManager", () => {
  test.each([
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ])("%s → %s", async (lockfile, expected) => {
    await writeFile(join(dir, lockfile), "");
    expect(await detectPackageManager(dir)).toBe(expected);
  });

  test("no lockfile defaults to npm — adoption is never gated behind one PM", async () => {
    expect(await detectPackageManager(dir)).toBe("npm");
  });

  test("bun wins when both bun and npm lockfiles are present (most specific first)", async () => {
    await writeFile(join(dir, "package-lock.json"), "");
    await writeFile(join(dir, "bun.lock"), "");
    expect(await detectPackageManager(dir)).toBe("bun");
  });
});

describe("installArgs", () => {
  test("npm installs, the others add", () => {
    expect(installArgs("npm", "@pithy-sh/auth")).toEqual(["install", "@pithy-sh/auth"]);
    expect(installArgs("pnpm", "@pithy-sh/auth")).toEqual(["add", "@pithy-sh/auth"]);
    expect(installArgs("yarn", "@pithy-sh/auth")).toEqual(["add", "@pithy-sh/auth"]);
    expect(installArgs("bun", "@pithy-sh/auth")).toEqual(["add", "@pithy-sh/auth"]);
  });

  test("takes many packages in one install invocation", () => {
    expect(installArgs("npm", ["hono@^4", "zod@^4"])).toEqual(["install", "hono@^4", "zod@^4"]);
  });
});

describe("uninstallArgs", () => {
  test("npm uninstalls, the others remove", () => {
    expect(uninstallArgs("npm", "@pithy-sh/auth")).toEqual(["uninstall", "@pithy-sh/auth"]);
    expect(uninstallArgs("pnpm", "@pithy-sh/auth")).toEqual(["remove", "@pithy-sh/auth"]);
    expect(uninstallArgs("yarn", "@pithy-sh/auth")).toEqual(["remove", "@pithy-sh/auth"]);
    expect(uninstallArgs("bun", "@pithy-sh/auth")).toEqual(["remove", "@pithy-sh/auth"]);
  });
});

describe("uninstallPackage", () => {
  test("detects the PM and runs its remove command in the project dir", async () => {
    await writeFile(join(dir, "bun.lock"), "");
    const calls: { command: string; args: string[]; cwd: string }[] = [];

    const result = await uninstallPackage({
      projectDir: dir,
      pkg: "@pithy-sh/auth",
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
      },
    });

    expect(result.packageManager).toBe("bun");
    expect(result.uninstalled).toBe(true);
    expect(calls).toEqual([{ command: "bun", args: ["remove", "@pithy-sh/auth"], cwd: dir }]);
  });

  test("declines for a package a linked checkout provides — nothing declared it, so nothing removes it", async () => {
    // The mirror of the install skip, and not a symmetry for its own sake. npm treats every undeclared
    // entry as extraneous and prunes the lot: `npm uninstall @pithy-sh/auth` over a linked scope takes
    // `secrets` and `core` with it, out from under a worker whose config still imports them. No lockfile
    // means npm, so that is the default path for the project this whole state exists to serve.
    await link(dir, "@pithy-sh/auth");
    await link(dir, "@pithy-sh/secrets");
    const calls: string[] = [];

    const result = await uninstallPackage({
      projectDir: dir,
      pkg: "@pithy-sh/auth",
      run: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
      },
    });

    expect(calls).toEqual([]);
    expect(result.uninstalled).toBe(false);
  });

  test("a registry install is still uninstalled — that one has a declaration to remove", async () => {
    await writeFile(join(dir, "bun.lock"), "");
    await place(dir, "@pithy-sh/auth");
    const calls: string[] = [];

    const result = await uninstallPackage({
      projectDir: dir,
      pkg: "@pithy-sh/auth",
      run: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
      },
    });

    expect(result.uninstalled).toBe(true);
    expect(calls).toEqual(["bun remove @pithy-sh/auth"]);
  });
});

describe("promoteDependencies", () => {
  test("adds every package in one command with the detected PM", async () => {
    await writeFile(join(dir, "yarn.lock"), "");
    const calls: { command: string; args: string[]; cwd: string }[] = [];

    const result = await promoteDependencies(dir, ["better-auth@^1.6.19", "zod@^4.0.0"], async (command, args, cwd) => {
      calls.push({ command, args, cwd });
    });

    expect(result.packageManager).toBe("yarn");
    expect(calls).toEqual([{ command: "yarn", args: ["add", "better-auth@^1.6.19", "zod@^4.0.0"], cwd: dir }]);
  });

  test("is a no-op when there is nothing to promote", async () => {
    let ran = false;
    await promoteDependencies(dir, [], async () => {
      ran = true;
    });
    expect(ran).toBe(false);
  });
});

describe("execArgs", () => {
  test("resolves a workspace-local bin per package manager", () => {
    expect(execArgs("bun", "wrangler", ["dev"])).toEqual({ command: "bun", args: ["x", "wrangler", "dev"] });
    expect(execArgs("pnpm", "wrangler", ["dev"])).toEqual({ command: "pnpm", args: ["exec", "wrangler", "dev"] });
    expect(execArgs("yarn", "wrangler", ["dev"])).toEqual({ command: "yarn", args: ["wrangler", "dev"] });
    expect(execArgs("npm", "wrangler", ["dev"])).toEqual({ command: "npx", args: ["wrangler", "dev"] });
  });
});

describe("installPackage", () => {
  test("detects the PM and runs its install command in the project dir", async () => {
    await writeFile(join(dir, "pnpm-lock.yaml"), "");
    const calls: { command: string; args: string[]; cwd: string }[] = [];

    const result = await installPackage({
      projectDir: dir,
      pkg: "@pithy-sh/auth",
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
      },
    });

    expect(result.packageManager).toBe("pnpm");
    expect(calls).toEqual([{ command: "pnpm", args: ["add", "@pithy-sh/auth"], cwd: dir }]);
  });

  test("skips the registry when the package is already provided — a local checkout installs nothing", async () => {
    await writeFile(join(dir, "bun.lock"), "");
    await link(dir, "@pithy-sh/secrets");
    const calls: string[] = [];

    const result = await installPackage({
      projectDir: dir,
      pkg: "@pithy-sh/secrets",
      run: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
      },
    });

    // The PM is still reported: `pithy add` names it, and the answer is the same either way.
    expect(result.packageManager).toBe("bun");
    expect(calls).toEqual([]);
  });
});

/** A real directory under `<root>/node_modules/<pkg>` — what a registry install leaves behind. */
async function place(root: string, pkg: string, manifest: { name: string } = { name: pkg }): Promise<string> {
  const packageDir = join(root, "node_modules", ...pkg.split("/"));
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify(manifest));
  return packageDir;
}

/** A checkout outside `node_modules`, symlinked in — what a workspace, `bun link`, or `file:` leaves behind. */
async function link(root: string, pkg: string, name = pkg): Promise<string> {
  const checkout = join(root, "checkouts", ...pkg.split("/"));
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, "package.json"), JSON.stringify({ name }));
  const at = join(root, "node_modules", ...pkg.split("/"));
  await mkdir(dirname(at), { recursive: true });
  await symlink(checkout, at, "dir");
  return checkout;
}

describe("alreadyProvided", () => {
  test("false when nothing is installed", async () => {
    expect(await alreadyProvided(dir, "@pithy-sh/vite")).toBe(false);
  });

  test("true for a checkout symlinked in — that is how a project provides an unpublished package", async () => {
    await link(dir, "@pithy-sh/vite");
    expect(await alreadyProvided(dir, "@pithy-sh/vite")).toBe(true);
  });

  test("false for a real directory in node_modules — that is a registry install, and it has a version", async () => {
    // Bun hoists transitive dependencies to the top level as real directories, and the scope depends on
    // itself (`auth` → `email`, `secrets`, `turnstile`). Calling a hoisted copy "provided" made
    // `pithy add email` after `pithy add auth` skip the install — so nothing declared it, and
    // `pithy remove auth` pruned it out from under a config that still imported it.
    await place(dir, "@pithy-sh/email");
    expect(await alreadyProvided(dir, "@pithy-sh/email")).toBe(false);
  });

  test("false for a link that lands back inside node_modules — that is pnpm's store, not a checkout", async () => {
    const store = join(dir, "node_modules", ".pnpm", "@pithy-sh+vite@0.0.0", "node_modules", "@pithy-sh", "vite");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "package.json"), JSON.stringify({ name: "@pithy-sh/vite" }));
    await mkdir(join(dir, "node_modules", "@pithy-sh"), { recursive: true });
    await symlink(store, join(dir, "node_modules", "@pithy-sh", "vite"), "dir");

    expect(await alreadyProvided(dir, "@pithy-sh/vite")).toBe(false);
  });

  test("a bare directory is not a resolution — the manifest is what makes it importable", async () => {
    await mkdir(join(dir, "node_modules", "@pithy-sh", "vite"), { recursive: true });
    expect(await alreadyProvided(dir, "@pithy-sh/vite")).toBe(false);
  });

  test("a manifest naming something else is not a resolution", async () => {
    await link(dir, "@pithy-sh/vite", "@pithy-sh/core");
    expect(await alreadyProvided(dir, "@pithy-sh/vite")).toBe(false);
  });

  test("a dangling symlink resolves to nothing", async () => {
    await mkdir(join(dir, "node_modules", "@pithy-sh"), { recursive: true });
    await symlink(join(dir, "gone"), join(dir, "node_modules", "@pithy-sh", "vite"), "dir");
    expect(await alreadyProvided(dir, "@pithy-sh/vite")).toBe(false);
  });

  test("an ancestor's node_modules does not count — the CLI never looks there either", async () => {
    // Node's own lookup walks up; this must not. `loadManifest` reads `projectDir/node_modules` and
    // nothing above it, so an ancestor hit skipped the install and then reported the capability as not
    // installed — telling the adopter to run the command that had just declined to run. Worse, `/tmp` and
    // `$HOME` are ancestors anyone can plant a `node_modules` in, and the wired config is imported.
    await link(dir, "@pithy-sh/vite");
    const nested = join(dir, "apps", "api");
    await mkdir(nested, { recursive: true });
    expect(await alreadyProvided(nested, "@pithy-sh/vite")).toBe(false);
  });

  test("false for a package outside the scope, however well it resolves", async () => {
    // react is on the registry. A range for it is correct and must keep being written.
    await link(dir, "react");
    expect(await alreadyProvided(dir, "react")).toBe(false);
  });
});

/**
 * The Worker's manifest is what says what the Worker is made of — #480.
 *
 * `pithy add <cap> --worker <w>` writes its import into `apps/<w>/pithy.config.ts`, so `apps/<w>` is
 * what depends on the capability. The install stays at the root, where the lockfile is and where every
 * manifest-discovery site looks; only the declaration moves.
 */
describe("declareOnWorker", () => {
  /**
   * A root declaring `pkg`, a Worker under `apps/api`, and an installed copy of `pkg` whose manifest
   * states `peers` — which is where the peer requirement is read from, never from a list in the CLI.
   */
  async function project(
    root: Record<string, string>,
    worker: Record<string, string>,
    installed: Record<string, unknown> = {},
  ): Promise<string> {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "root", dependencies: root }));
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(
      join(dir, "apps", "api", "package.json"),
      JSON.stringify({ name: "api", dependencies: worker }, null, 2),
    );
    for (const [pkg, manifest] of Object.entries(installed)) {
      const at = join(dir, "node_modules", ...pkg.split("/"));
      await mkdir(at, { recursive: true });
      await writeFile(join(at, "package.json"), JSON.stringify({ name: pkg, ...(manifest as object) }));
    }
    return join(dir, "apps", "api");
  }

  /** What the Worker's manifest declares now. */
  async function workerDeps(): Promise<Record<string, string>> {
    const raw = await readFile(join(dir, "apps", "api", "package.json"), "utf8");
    return (JSON.parse(raw) as { dependencies: Record<string, string> }).dependencies;
  }

  test("copies the range the root resolved, rather than inventing one", async () => {
    const workerDir = await project({ "@pithy-sh/auth": "^0.1.4" }, { "@pithy-sh/core": "^0.1.4" });

    expect(await declareOnWorker(dir, workerDir, "@pithy-sh/auth")).toEqual(["@pithy-sh/auth"]);
    expect(await workerDeps()).toEqual({ "@pithy-sh/core": "^0.1.4", "@pithy-sh/auth": "^0.1.4" });
  });

  /**
   * **The half 0.1.3 shipped without.** A peer is a requirement on the consumer, and npm satisfies one
   * at the top while bun, for a workspace member, does not — so a Worker that declared its capabilities
   * and not their peers could not resolve `zod` at all, and `@pithy-sh/core` failed to load inside the
   * project with `ERR_MODULE_NOT_FOUND`.
   */
  test("declares the capability's required peers with it", async () => {
    const workerDir = await project(
      { "@pithy-sh/auth": "^0.1.4" },
      { "@pithy-sh/core": "^0.1.4" },
      { "@pithy-sh/auth": { peerDependencies: { zod: "^4.4.0", kysely: "^0.29.0" } } },
    );

    expect((await declareOnWorker(dir, workerDir, "@pithy-sh/auth")).sort()).toEqual([
      "@pithy-sh/auth",
      "kysely",
      "zod",
    ]);
    expect(await workerDeps()).toMatchObject({ zod: "^4.4.0", kysely: "^0.29.0" });
  });

  // React is used only by `client/` and `react/` modules an adopter reaches by importing them. A server
  // composition never does, and installing it to satisfy a module that will not load is a worse answer
  // than the resolution failure it prevents.
  test("skips an optional peer", async () => {
    const workerDir = await project(
      { "@pithy-sh/payments": "^0.1.4" },
      {},
      {
        "@pithy-sh/payments": {
          peerDependencies: { zod: "^4.4.0", react: "^19.0.0" },
          peerDependenciesMeta: { react: { optional: true } },
        },
      },
    );

    await declareOnWorker(dir, workerDir, "@pithy-sh/payments");
    expect(await workerDeps()).toMatchObject({ zod: "^4.4.0" });
    expect(await workerDeps()).not.toHaveProperty("react");
  });

  // A kit sibling peer is a *prerequisite*: the CLI refuses a composition missing one and names the
  // command that fixes it, and once composed it is declared by its own `pithy add`. Every kit peer of
  // that shape carries `peerDependenciesMeta.optional` — `@pithy-sh/support` really does — which is what
  // lets one rule (`optional`) say both this and React, rather than a second rule about the scope (#542).
  test("skips a kit sibling, which the prerequisite check owns", async () => {
    const workerDir = await project(
      { "@pithy-sh/support": "^0.1.4" },
      {},
      {
        "@pithy-sh/support": {
          peerDependencies: { "@pithy-sh/auth": "^0.1.4", zod: "^4.4.0" },
          peerDependenciesMeta: { "@pithy-sh/auth": { optional: true } },
        },
      },
    );

    await declareOnWorker(dir, workerDir, "@pithy-sh/support");
    expect(await workerDeps()).not.toHaveProperty("@pithy-sh/auth");
    expect(await workerDeps()).toMatchObject({ zod: "^4.4.0" });
  });

  /**
   * **A *required* kit peer is declared like any other required peer — #542.**
   *
   * `@pithy-sh/core` is a peer of every capability and `@pithy-sh/secrets` a peer of the six that read a
   * secret, because two copies of either is the defect: two `Capability` types the compiler will not name,
   * and two module-level `config`s where `configureSharedSecrets` wrote to one and every reader holds the
   * other. Skipping them here on the grounds that they are kit-scoped leaves the Worker declaring a
   * capability whose own requirements nothing satisfies — 0.1.3's `ERR_MODULE_NOT_FOUND` with a
   * `@pithy-sh/*` name in it.
   */
  test("declares a required kit peer, which is not a prerequisite to compose", async () => {
    const workerDir = await project(
      { "@pithy-sh/turnstile": "^0.1.6" },
      {},
      {
        "@pithy-sh/turnstile": {
          peerDependencies: { "@pithy-sh/core": "^0.3.0", "@pithy-sh/secrets": "^0.1.6", zod: "^4.4.0" },
        },
      },
    );

    expect((await declareOnWorker(dir, workerDir, "@pithy-sh/turnstile")).sort()).toEqual([
      "@pithy-sh/core",
      "@pithy-sh/secrets",
      "@pithy-sh/turnstile",
      "zod",
    ]);
    expect(await workerDeps()).toMatchObject({
      "@pithy-sh/core": "^0.3.0",
      "@pithy-sh/secrets": "^0.1.6",
    });
  });

  // Merge, never replace — the same rule `pithy ui add` follows. An adopter who pinned a version keeps it.
  test("leaves a range the Worker already declares alone", async () => {
    const workerDir = await project(
      { "@pithy-sh/auth": "^0.1.4" },
      { "@pithy-sh/auth": "0.1.3", zod: "4.4.0" },
      { "@pithy-sh/auth": { peerDependencies: { zod: "^4.4.0" } } },
    );

    expect(await declareOnWorker(dir, workerDir, "@pithy-sh/auth")).toEqual([]);
    expect(await workerDeps()).toEqual({ "@pithy-sh/auth": "0.1.3", zod: "4.4.0" });
  });

  // The linked-checkout case `installPackage` documents: nothing is declared anywhere, because the only
  // range available names a version no registry has.
  test("writes nothing when the root declares nothing", async () => {
    const workerDir = await project({}, { "@pithy-sh/core": "^0.1.4" });

    expect(await declareOnWorker(dir, workerDir, "@pithy-sh/auth")).toEqual([]);
    expect(await workerDeps()).toEqual({ "@pithy-sh/core": "^0.1.4" });
  });

  /**
   * **It runs on every `pithy add`, so a second run must write nothing.**
   *
   * `addCapability` is idempotent by contract — CI re-runs it, and a script re-applies a manifest over a
   * project that already composes the capability. This step is inside that contract now, and it declares
   * more than it used to: the package *and* its peers. Answering `[]` is the observable half; not
   * touching the file is the half that matters, because a rewrite of identical bytes still shows up as a
   * dirty tree in whatever runs next.
   */
  test("writes nothing at all on a second run", async () => {
    const workerDir = await project(
      { "@pithy-sh/auth": "^0.1.4" },
      { "@pithy-sh/core": "^0.1.4" },
      { "@pithy-sh/auth": { peerDependencies: { zod: "^4.4.0", kysely: "^0.29.0" } } },
    );
    const path = join(dir, "apps", "api", "package.json");

    expect((await declareOnWorker(dir, workerDir, "@pithy-sh/auth")).length).toBe(3);
    const after = await readFile(path, "utf8");
    const stamp = (await stat(path)).mtimeMs;

    expect(await declareOnWorker(dir, workerDir, "@pithy-sh/auth")).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(after);
    expect((await stat(path)).mtimeMs).toBe(stamp);
  });

  // The partial case, which is the one a plain "already declared?" guard gets wrong: the package is
  // there from an earlier run and a peer is not, so exactly the peer is added.
  test("adds only what is missing when some of it is already declared", async () => {
    const workerDir = await project(
      { "@pithy-sh/auth": "^0.1.4" },
      { "@pithy-sh/auth": "^0.1.4", zod: "^4.4.0" },
      { "@pithy-sh/auth": { peerDependencies: { zod: "^4.4.0", kysely: "^0.29.0" } } },
    );

    expect(await declareOnWorker(dir, workerDir, "@pithy-sh/auth")).toEqual(["kysely"]);
    expect(await workerDeps()).toEqual({ "@pithy-sh/auth": "^0.1.4", zod: "^4.4.0", kysely: "^0.29.0" });
  });

  test("answers empty rather than throwing when the Worker has no manifest", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { "@pithy-sh/auth": "^0.1.4" } }));
    expect(await declareOnWorker(dir, join(dir, "apps", "gone"), "@pithy-sh/auth")).toEqual([]);
  });
});
