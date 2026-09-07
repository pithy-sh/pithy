// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { writeFileAtomic } from "./atomic";
import { readOptionalFile } from "./readOptionalFile";

const run = promisify(execFile);

/** The package managers a Pithy adopter might use. Adoption is never gated behind Bun. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Lockfile → package manager, most specific first. `bun.lock` precedes
 * `package-lock.json` so a project carrying both (a Bun project npm once touched)
 * resolves to Bun. The fallback is npm — present on every Node install.
 */
const LOCKFILES: readonly [string, PackageManager][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Detect the project's package manager from its lockfile; npm when none is found. */
export async function detectPackageManager(projectDir: string): Promise<PackageManager> {
  for (const [lockfile, pm] of LOCKFILES) {
    if (await exists(join(projectDir, lockfile))) return pm;
  }
  return "npm";
}

/** The install argv for a package manager: npm `install`, the rest `add`, for one or many packages. */
export function installArgs(pm: PackageManager, pkgs: string | string[]): string[] {
  const list = Array.isArray(pkgs) ? pkgs : [pkgs];
  return [pm === "npm" ? "install" : "add", ...list];
}

/** The uninstall argv for a package manager: npm `uninstall`, the rest `remove`. */
export function uninstallArgs(pm: PackageManager, pkg: string): string[] {
  return [pm === "npm" ? "uninstall" : "remove", pkg];
}

/**
 * Resolve a package binary through the project's package manager, so `pithy` never assumes a global
 * install. Each manager has its own "run a workspace-local bin" invocation:
 * `bun x <bin>`, `pnpm exec <bin>`, `yarn <bin>`, `npx <bin>`. The returned `{ command, args }` is
 * ready to hand to `child_process.spawn`.
 */
export function execArgs(pm: PackageManager, bin: string, args: string[]): { command: string; args: string[] } {
  switch (pm) {
    case "bun":
      return { command: "bun", args: ["x", bin, ...args] };
    case "pnpm":
      return { command: "pnpm", args: ["exec", bin, ...args] };
    case "yarn":
      return { command: "yarn", args: [bin, ...args] };
    default:
      return { command: "npx", args: [bin, ...args] };
  }
}

/** The scope every package this kit ships lives under. */
const PITHY_SCOPE = "@pithy-sh/";

/**
 * Whether `projectDir/node_modules/<pkg>` is a **checkout linked in** rather than something a registry
 * install put there.
 *
 * Two conditions, and both are load-bearing.
 *
 * *At the project root, and only there.* Node's own lookup walks `node_modules` up every ancestor to
 * `/`; this deliberately does not. The rest of the CLI never walks — `loadManifest` reads
 * `projectDir/node_modules/@pithy-sh/<pkg>` and nothing above it — so an ancestor hit made `pithy add`
 * skip the install and then report the capability as not installed, telling the adopter to run the
 * command that had just declined to run. And walking is a way in: `/tmp` and `$HOME` are ancestors
 * anyone can leave a `node_modules` in, `pithy add` wires the resolved package into `pithy.config.ts`,
 * and `pithy migrate` imports that config. Bounded, a planted copy is shadowed by a real install again.
 *
 * *Resolving out of `node_modules`.* A registry install is a real directory under `node_modules` — bun
 * hoists transitive dependencies there too, and the scope depends on itself (`auth` pulls `email`,
 * `secrets`, `turnstile`). Treating a hoisted copy as provided meant `pithy add email` after
 * `pithy add auth` declared nothing, and `pithy remove auth` then pruned it out from under a config that
 * still imported it. A link that lands *outside* `node_modules` is the thing that has no version to
 * write: a workspace member, a `bun link`, a `file:` dependency. pnpm's store is inside `node_modules`,
 * so its symlinks read as the registry installs they are.
 *
 * The manifest is read rather than the directory stat'ed, because a stat answers the wrong question. The
 * checkout a link points at can be gone, and an `@pithy-sh` folder can be left behind empty by a
 * half-finished remove. Reading `package.json` and checking the name it declares is what "importable"
 * actually means.
 */
async function linkedFromCheckout(projectDir: string, pkg: string): Promise<boolean> {
  const modules = join(projectDir, "node_modules");
  const at = join(modules, ...pkg.split("/"));
  let resolved: string;
  let root: string;
  try {
    const raw = await readFile(join(at, "package.json"), "utf8");
    if ((JSON.parse(raw) as { name?: unknown }).name !== pkg) return false;
    // Both sides through `realpath`, or a `node_modules` reached by a symlinked path — a macOS tmpdir,
    // a symlinked home — would read as outside itself and call every install a checkout.
    [resolved, root] = await Promise.all([realpath(at), realpath(modules)]);
  } catch {
    // Missing, dangling, unreadable, or unparsable. None of them is a resolution.
    return false;
  }
  return relative(root, resolved).startsWith("..");
}

/**
 * Whether a `@pithy-sh/*` package is already provided by the project, so nothing should reach for the
 * registry on its behalf — neither an install nor a version range written into a `package.json`.
 *
 * Nothing under `@pithy-sh/*` is published yet, so a project working against a local checkout links the
 * packages in and every registry reference 404s: `pithy add secrets` failed on `bun add`, and
 * `pithy ui add react` succeeded while writing a `"@pithy-sh/vite": "^0.0.0"` that broke the *next*
 * install. One predicate, both call sites, no flag to remember. Once the packages publish it goes quiet:
 * an installed copy is a real directory with a real version, so the normal path runs and declares it.
 *
 * The scope is part of the rule, not incidental. `react` linked into the project says only that someone
 * is developing against a fork — its range is still correct and must still be written.
 */
export async function alreadyProvided(projectDir: string, pkg: string): Promise<boolean> {
  return pkg.startsWith(PITHY_SCOPE) && (await linkedFromCheckout(projectDir, pkg));
}

/** Spawn a package manager. Injectable so the flow is testable without a real install. */
export type InstallRunner = (command: string, args: string[], cwd: string) => Promise<void>;

const spawnInstall: InstallRunner = async (command, args, cwd) => {
  try {
    await run(command, args, { cwd });
  } catch (cause) {
    throw new InternalError({
      message: `${command} ${args.join(" ")} failed.`,
      action: `Install the package by hand: ${command} ${args.join(" ")}.`,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

export interface InstallPackageOptions {
  /** The project root — where the lockfile lives and the install runs. */
  projectDir: string;
  /** The package to install, e.g. `@pithy-sh/auth`. */
  pkg: string;
  /** Override the spawner (tests inject a stub); defaults to the real install. */
  run?: InstallRunner;
}

/**
 * Install a package with the project's detected package manager. Returns the project's manager, so
 * `pithy add` can report it. The adopter's PM is always used — Bun stays a dev-only signal, never a
 * requirement of adoption. The manager is detected whether or not an install runs: it is a fact about
 * the project, not a record of a spawn, and the caller only ever renders it as "run `<pm> install`".
 *
 * A package a linked checkout already provides is skipped ({@link alreadyProvided}), and the trade is
 * deliberate: nothing then declares it in a `package.json`. That is the point. The only range there is
 * to write names a version no registry has, and writing it breaks the adopter's next install — the
 * failure `pithy ui add` used to plant on a command days away. A checkout is already outside the
 * lockfile's world; the moment the scope publishes, the copy is a real directory and this stops firing.
 */
export async function installPackage(options: InstallPackageOptions): Promise<{ packageManager: PackageManager }> {
  const packageManager = await detectPackageManager(options.projectDir);
  if (await alreadyProvided(options.projectDir, options.pkg)) return { packageManager };
  await (options.run ?? spawnInstall)(packageManager, installArgs(packageManager, options.pkg), options.projectDir);
  return { packageManager };
}

export interface UninstallPackageOptions {
  /** The project root — where the lockfile lives and the uninstall runs. */
  projectDir: string;
  /** The package to uninstall, e.g. `@pithy-sh/auth`. */
  pkg: string;
  /** Override the spawner (tests inject a stub); defaults to the real uninstall. */
  run?: InstallRunner;
}

/** What an uninstall did: the manager it would use, and whether it actually removed anything. */
export interface UninstallOutcome {
  /** The project's package manager — reported whether or not an uninstall ran, like {@link installPackage}. */
  packageManager: PackageManager;
  /** False when the package was left alone because a linked checkout provides it. */
  uninstalled: boolean;
}

/**
 * Uninstall a package with the project's detected package manager — the inverse of {@link installPackage},
 * behind `pithy remove`. Returns which manager ran, and whether anything was removed. The adopter's PM is
 * always used.
 *
 * A package a linked checkout provides is **not** uninstalled ({@link alreadyProvided}), exactly as the
 * install skips it, and the asymmetry was the bug: nothing declared the package, so there is no
 * declaration for a remove to take out — but every manager is asked anyway, and npm answers by pruning
 * the *whole* linked scope as extraneous. One `pithy remove auth` unlinked `secrets` and `core` out from
 * under the same worker's config, which still imports them. `detectPackageManager` returns npm for a
 * project with no lockfile, so that is the default path here, not an edge.
 *
 * The alternative was to make the caller check first. It is the same predicate the install already owns,
 * and a guard every call site must remember is a guard one of them forgets.
 */
export async function uninstallPackage(options: UninstallPackageOptions): Promise<UninstallOutcome> {
  const packageManager = await detectPackageManager(options.projectDir);
  if (await alreadyProvided(options.projectDir, options.pkg)) return { packageManager, uninstalled: false };
  await (options.run ?? spawnInstall)(packageManager, uninstallArgs(packageManager, options.pkg), options.projectDir);
  return { packageManager, uninstalled: true };
}

/**
 * Add several packages at once with the project's detected package manager — one install invocation.
 * Used by `--eject` to promote a forked capability's runtime dependencies (`better-auth`, `zod`, …)
 * into the project so the local copy builds without the `@pithy-sh/*` package. A no-op when the list
 * is empty. Returns which manager ran.
 */
export async function promoteDependencies(
  projectDir: string,
  packages: string[],
  runner?: InstallRunner,
): Promise<{ packageManager: PackageManager }> {
  const packageManager = await detectPackageManager(projectDir);
  if (packages.length > 0) {
    await (runner ?? spawnInstall)(packageManager, installArgs(packageManager, packages), projectDir);
  }
  return { packageManager };
}

/**
 * Declare `pkg` in the Worker's own `package.json`, at the range the project root resolved it to.
 *
 * ## Why a capability is declared twice
 *
 * The install runs at the root, because that is where the lockfile is and where every one of the CLI's
 * nine manifest-discovery sites looks. But `pithy add <cap> --worker <w>` writes its import into
 * `apps/<w>/pithy.config.ts`, so `apps/<w>` is what actually depends on the capability — and until
 * #480 nothing said so. The Worker's manifest, which the scaffold's own comments describe as what this
 * Worker is made of, listed `@pithy-sh/core` and nothing else however many capabilities it composed.
 *
 * That is not only tidiness. The composed config is per-Worker by design: two Workers are meant to
 * compose different sets, and a single root dependency list cannot express that — neither Worker's
 * manifest says what it is. And under a package manager that does not hoist, a capability declared only
 * at the root is not linked beside the Worker at all.
 *
 * `pithy ui add` has always written into `apps/<worker>/package.json`, which is the precedent this
 * follows rather than a new idea.
 *
 * ## The range is read back, never invented
 *
 * Whatever the install just wrote at the root is what the Worker gets, so the two cannot disagree and
 * this file never has to know how a manager spells a range. A package the root does not declare — the
 * linked-checkout case {@link installPackage} documents, where nothing is written anywhere — is left
 * alone here too, for the same reason: the only range available names a version no registry has.
 *
 * Merge, never replace: a range the adopter already chose survives untouched.
 */
export async function declareOnWorker(projectDir: string, workerDir: string, pkg: string): Promise<string | null> {
  const rootRaw = await readOptionalFile(join(projectDir, "package.json"));
  if (rootRaw === null) return null;
  const root = JSON.parse(rootRaw) as { dependencies?: Record<string, string> };
  const range = root.dependencies?.[pkg];
  if (range === undefined) return null;

  const path = join(workerDir, "package.json");
  const workerRaw = await readOptionalFile(path);
  if (workerRaw === null) return null;
  const worker = JSON.parse(workerRaw) as { dependencies?: Record<string, string> };
  if (worker.dependencies?.[pkg] !== undefined) return null;

  worker.dependencies = { ...(worker.dependencies ?? {}), [pkg]: range };
  await writeFileAtomic(path, `${JSON.stringify(worker, null, 2)}\n`);
  return range;
}
