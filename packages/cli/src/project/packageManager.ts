// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { PACKAGE_EXEC } from "@pithy-sh/core/src/cli/command";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { execCommand } from "../platform/command";
import { startStep } from "../terminal/progress";
import { writeFileAtomic } from "./atomic";
import { installDirFor, installedPackageBase, resolutionChain, uninstallDirFor } from "./installedPackage";
import { readOptionalFile } from "./readOptionalFile";

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

/**
 * The project's lockfile and the manager it belongs to, or `null` when there is none — the most specific
 * first, by {@link LOCKFILES}. `pithy setup` reads the file's name as well as the manager, because it says
 * which file it installs against.
 */
export async function detectLockfile(projectDir: string): Promise<{ lockfile: string; pm: PackageManager } | null> {
  for (const [lockfile, pm] of LOCKFILES) {
    if (await exists(join(projectDir, lockfile))) return { lockfile, pm };
  }
  return null;
}

/** Detect the project's package manager from its lockfile; npm when none is found. */
export async function detectPackageManager(projectDir: string): Promise<PackageManager> {
  return (await detectLockfile(projectDir))?.pm ?? "npm";
}

/**
 * The package manager that launched this process, from `npm_config_user_agent` — `bun/1.4.2 …`,
 * `pnpm/10.0.0 …`, `yarn/4.5.0 …`, `npm/11.0.0 …` — or `undefined` when no runner set it, as with a
 * globally installed `pithy`.
 *
 * For the one moment a lockfile cannot answer: `pithy init --target web` wires the front end before
 * anything is installed, so {@link detectPackageManager} would find no lockfile and say `npm` for a project
 * the adopter is about to install with Bun. The user agent is the runner they chose, and the best evidence
 * there is until the lockfile exists.
 */
export function packageManagerFromUserAgent(env: NodeJS.ProcessEnv = process.env): PackageManager | undefined {
  const name = env.npm_config_user_agent?.split("/")[0]?.trim();
  return name === "bun" || name === "pnpm" || name === "yarn" || name === "npm" ? name : undefined;
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
  // One table with the lines that name a command run this way (`viaPackageManager`), so the two cannot disagree.
  const [command, ...prefix] = PACKAGE_EXEC[pm];
  return { command, args: [...prefix, bin, ...args] };
}

/** The scope every package this kit ships lives under. */
const PITHY_SCOPE = "@pithy-sh/";

/**
 * Whether the copy of `pkg` that code in `fromDir` resolves is a **checkout linked in** rather than something a
 * registry install put there.
 *
 * Two conditions, and both are load-bearing.
 *
 * *Found the way the rest of the CLI finds a package* ({@link installedPackageBase}): the Worker's own
 * `node_modules`, then each parent's, up to the project root and never above it. `/tmp` and `$HOME` are
 * ancestors anyone can leave a `node_modules` in, `pithy add` wires the resolved package into `pithy.config.ts`,
 * and `pithy migrate` imports that config.
 *
 * *Resolving out of every `node_modules` on that walk.* A registry install lands inside one: a real directory —
 * bun hoists transitive dependencies to the top as real directories, and the scope depends on itself (`auth`
 * pulls `email`, `secrets`, `turnstile`) — or a link into a store under the root's `node_modules`, which is where
 * pnpm's `.pnpm` and Bun's isolated `.bun` keep a member's dependencies. A hoisted copy treated as provided would
 * leave `pithy add email` after `pithy add auth` declaring nothing, for `pithy remove auth` to prune out from under
 * a config that still imports it. A link that lands *outside* all of them is the thing that has no version to
 * write: a workspace member, a `bun link`, a `file:` dependency.
 *
 * The manifest is read rather than the directory stat'ed, because a stat answers the wrong question. The
 * checkout a link points at can be gone, and an `@pithy-sh` folder can be left behind empty by a
 * half-finished remove. Reading `package.json` and checking the name it declares is what "importable"
 * actually means.
 */
async function linkedFromCheckout(projectDir: string, fromDir: string, pkg: string): Promise<boolean> {
  const base = await installedPackageBase(projectDir, fromDir, pkg);
  if (base === null) return false;
  const at = join(base, "node_modules", ...pkg.split("/"));
  let resolved: string;
  let stores: string[];
  try {
    const raw = await readFile(join(at, "package.json"), "utf8");
    if ((JSON.parse(raw) as { name?: unknown }).name !== pkg) return false;
    // Every side through `realpath`, or a `node_modules` reached by a symlinked path — a macOS tmpdir,
    // a symlinked home — would read as outside itself and call every install a checkout.
    resolved = await realpath(at);
    stores = await Promise.all(
      resolutionChain(projectDir, base).map((dir) => realpath(join(dir, "node_modules")).catch(() => null)),
    ).then((dirs) => dirs.filter((dir): dir is string => dir !== null));
  } catch {
    // Missing, dangling, unreadable, or unparsable. None of them is a resolution.
    return false;
  }
  return stores.every((store) => relative(store, resolved).startsWith(".."));
}

/**
 * Whether a `@pithy-sh/*` package is already provided by the project, as code in `fromDir` resolves it (the
 * root by default), so nothing should reach for the registry on its behalf — neither an install nor a version
 * range written into a `package.json`.
 *
 * A project working against a local checkout links the packages in, and a registry reference to a version
 * only the checkout has 404s: `bun add` fails, and a range like `"@pithy-sh/vite": "^0.0.0"` breaks the
 * *next* install. One predicate, both call sites, no flag to remember. An installed copy is a real
 * directory with a real version, so the normal path runs and declares it.
 *
 * The scope is part of the rule, not incidental. `react` linked into the project says only that someone
 * is developing against a fork — its range is still correct and must still be written.
 */
export async function alreadyProvided(projectDir: string, pkg: string, fromDir: string = projectDir): Promise<boolean> {
  return pkg.startsWith(PITHY_SCOPE) && (await linkedFromCheckout(projectDir, fromDir, pkg));
}

/** Spawn a package manager. Injectable so the flow is testable without a real install. */
export type InstallRunner = (command: string, args: string[], cwd: string) => Promise<void>;

/**
 * **Run the package manager, captured, under a step naming the command line.**
 *
 * The one place the CLI starts `bun add`, `npm uninstall`, `<pm> install`. Its output is collected, never
 * streamed, which is right for a log and leaves nothing on the terminal while a cold install runs for
 * minutes — so it says `▸ Running bun add @pithy-sh/auth...` before the child exists. Outside a narrated
 * span, and under `--json`, that is silent.
 *
 * `pithy add`, `pithy worker add` and `pithy feature create` all spawn through it, so the step is raised
 * once and no caller can forget it. It throws the child's own error; what a failure means is the caller's
 * sentence to write.
 */
export const runPackageManager: InstallRunner = async (command, args, cwd) => {
  startStep(`Running ${[command, ...args].join(" ")}`);
  await execCommand(command, args, { cwd });
};

/** `run`, with a failure turned into the error that names the command to run by hand. */
function guarded(run: InstallRunner): InstallRunner {
  return async (command, args, cwd) => {
    try {
      await run(command, args, cwd);
    } catch (cause) {
      throw new InternalError({
        message: `${command} ${args.join(" ")} failed.`,
        action: `Install the package by hand: ${command} ${args.join(" ")}.`,
        // The installer's captured output, without its color: a `--json` error line carries it.
        detail: stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause)),
      });
    }
  };
}

const spawnInstall: InstallRunner = guarded(runPackageManager);

/**
 * Bring the project's lockfile in step with a `package.json` the CLI wrote itself: `<pm> install` at the root, with
 * the manager the lockfile belongs to. A project with no lockfile has nothing to keep in step, and runs nothing.
 */
export async function syncLockfile(projectDir: string, run: InstallRunner = runPackageManager): Promise<void> {
  const found = await detectLockfile(projectDir);
  if (found === null) return;
  await guarded(run)(found.pm, ["install"], projectDir);
}

export interface InstallPackageOptions {
  /** The project root — where the lockfile lives, and where the install runs when no Worker owns it. */
  projectDir: string;
  /**
   * The Worker the package is for. When it is a workspace member, the install runs in its directory, so the
   * dependency is declared in its `package.json` and not the root's ({@link installDirFor}).
   */
  workerDir?: string;
  /** The package to install, e.g. `@pithy-sh/auth`. */
  pkg: string;
  /** Override the spawner (tests inject a stub); defaults to the real install. */
  run?: InstallRunner;
}

/**
 * Install a package with the project's detected package manager, in the Worker that composes it when that Worker
 * is a workspace member and at the root otherwise. Returns the project's manager, so `pithy add` can report it.
 * The adopter's PM is always used — Bun stays a dev-only signal, never a requirement of adoption. The manager is
 * detected whether or not an install runs: it is a fact about the project, not a record of a spawn, and the
 * caller only ever renders it as "run `<pm> install`".
 *
 * A package a linked checkout already provides is skipped ({@link alreadyProvided}), and the trade is
 * deliberate: nothing then declares it in a `package.json`. The only range there is to write names a version no
 * registry has, and writing it breaks the adopter's next install. A checkout is already outside the lockfile's
 * world; the moment the scope publishes, the copy is a real directory and this stops firing.
 */
export async function installPackage(options: InstallPackageOptions): Promise<{ packageManager: PackageManager }> {
  const { projectDir, pkg } = options;
  const packageManager = await detectPackageManager(projectDir);
  const workerDir = options.workerDir ?? projectDir;
  if (await alreadyProvided(projectDir, pkg, workerDir)) return { packageManager };
  const cwd = await installDirFor(projectDir, workerDir);
  await (options.run ?? spawnInstall)(packageManager, installArgs(packageManager, pkg), cwd);
  return { packageManager };
}

export interface UninstallPackageOptions {
  /** The project root — where the lockfile lives, and where the uninstall runs when no Worker owns it. */
  projectDir: string;
  /** The Worker the package was installed for: the uninstall runs where it is declared, the Worker's member first. */
  workerDir?: string;
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
 * install skips it: nothing declared the package, so there is no declaration for a remove to take out, and
 * npm, asked anyway, prunes the *whole* linked scope as extraneous — `secrets` and `core` out from under a
 * config that still imports them. `detectPackageManager` returns npm for a project with no lockfile, so that
 * is the default path here, not an edge. The predicate lives here rather than at each call site, so no
 * caller can forget it.
 */
export async function uninstallPackage(options: UninstallPackageOptions): Promise<UninstallOutcome> {
  const { projectDir, pkg } = options;
  const packageManager = await detectPackageManager(projectDir);
  const workerDir = options.workerDir ?? projectDir;
  if (await alreadyProvided(projectDir, pkg, workerDir)) return { packageManager, uninstalled: false };
  const cwd = await uninstallDirFor(projectDir, workerDir, pkg);
  await (options.run ?? spawnInstall)(packageManager, uninstallArgs(packageManager, pkg), cwd);
  return { packageManager, uninstalled: true };
}

/**
 * Add several packages at once with the project's detected package manager — one install invocation, in
 * `workerDir` when it is a workspace member and at the root otherwise ({@link installDirFor}). Used by
 * `--eject` to promote a forked capability's runtime dependencies (`better-auth`, `zod`, …) into the Worker
 * that holds the copy, so it builds without the `@pithy-sh/*` package. A no-op when the list is empty.
 * Returns which manager ran.
 */
export async function promoteDependencies(
  projectDir: string,
  packages: string[],
  runner?: InstallRunner,
  workerDir: string = projectDir,
): Promise<{ packageManager: PackageManager }> {
  const packageManager = await detectPackageManager(projectDir);
  if (packages.length > 0) {
    const cwd = await installDirFor(projectDir, workerDir);
    await (runner ?? spawnInstall)(packageManager, installArgs(packageManager, packages), cwd);
  }
  return { packageManager };
}

/**
 * Declare `pkg`, and what it requires its consumer to provide, in the Worker's own `package.json`, sorted.
 *
 * `apps/<w>/pithy.config.ts` is what imports the capability, so `apps/<w>` is what depends on it: two Workers are
 * meant to compose different sets, and only each Worker's own manifest can say what it is made of. Under a
 * package manager that does not hoist, a dependency declared anywhere else is not linked beside the Worker at all.
 *
 * ## The range is read back, never invented
 *
 * The Worker's own range when the install wrote one there ({@link installPackage} runs in a workspace member),
 * else the root's when it ran at the root. Whatever the install just wrote is what the Worker gets, so this file
 * never has to know how a manager spells a range. A package neither declares — the linked-checkout case
 * {@link installPackage} documents — is left alone here too: the only range available names a version no
 * registry has.
 *
 * Merge, never replace: a range the adopter already chose survives untouched. What is written is written in name
 * order, the order every package manager writes.
 *
 * ## The capability's required peers come with it
 *
 * `zod`, `kysely` and `hono` are `peerDependencies` of every capability, because a second copy of any of them is
 * a second *type* and the compiler will not say so. A peer is a requirement on the consumer, and something has to
 * satisfy it — **npm installs a peer at the top; bun, for a workspace member, does not.** Without the Worker
 * declaring them, `zod` and `kysely` are linked nowhere and `@pithy-sh/core` cannot load from `apps/<w>`
 * (`ERR_MODULE_NOT_FOUND: Cannot find package '@pithy-sh/core'`).
 *
 * So whoever declares a kit package on a Worker also declares what that package requires the Worker to provide.
 * **Read from the package as the Worker resolves it rather than listed here**, because a list is a second copy of
 * a fact the manifest already states and would be one release behind the first capability to need something new.
 *
 * **One kind is skipped, and `optional` is the whole of the rule.**
 *
 * - **An optional peer.** `@pithy-sh/payments` and `@pithy-sh/i18n` declare `react`, used only by their
 *   `client/` and `react/` modules — an adopter reaches those by importing them, and a server composition never
 *   does. `peerDependenciesMeta` says so, and installing React into a Worker to satisfy a module it will never
 *   load is a worse answer than the resolution failure it prevents.
 *   **A kit sibling is the same skip, arrived at from the other side.** `@pithy-sh/support` peers
 *   `@pithy-sh/auth`, which is a *prerequisite*: the CLI refuses a composition missing one and names the command
 *   that fixes it, and once composed it is declared by its own `pithy add`. Every kit peer of that shape carries
 *   `peerDependenciesMeta.optional`, so saying `optional` says both.
 *
 * **The kit scope is not skipped.** `@pithy-sh/core` is a **required** peer of every capability, and
 * `@pithy-sh/secrets`, `@pithy-sh/email`, `@pithy-sh/storage`, `@pithy-sh/turnstile` and `@pithy-sh/cloudflare`
 * are required peers of the capabilities that read them — because a second copy of `core` is a second
 * `Capability` type, and a second copy of `secrets` is a second module-level `config` that
 * `configureSharedSecrets` never wrote to. A scope filter would drop exactly those from the Worker that composes
 * them.
 */
export async function declareOnWorker(projectDir: string, workerDir: string, pkg: string): Promise<string[]> {
  const path = join(workerDir, "package.json");
  const workerRaw = await readOptionalFile(path);
  if (workerRaw === null) return [];
  const worker = JSON.parse(workerRaw) as { dependencies?: Record<string, string> };

  const range = worker.dependencies?.[pkg] ?? (await rootRange(projectDir, pkg));
  if (range === undefined) return [];

  const wanted: Record<string, string> = { [pkg]: range, ...(await requiredPeers(projectDir, workerDir, pkg)) };
  const added = Object.entries(wanted).filter(([name]) => worker.dependencies?.[name] === undefined);
  if (added.length === 0) return [];

  const merged = { ...(worker.dependencies ?? {}), ...Object.fromEntries(added) };
  worker.dependencies = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await writeFileAtomic(path, `${JSON.stringify(worker, null, 2)}\n`);
  return added.map(([name]) => name);
}

/** The range the root `package.json` declares `pkg` at, or `undefined`. */
async function rootRange(projectDir: string, pkg: string): Promise<string | undefined> {
  const raw = await readOptionalFile(join(projectDir, "package.json"));
  if (raw === null) return undefined;
  return (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies?.[pkg];
}

/** What `pkg`, as the Worker resolves it, requires its consumer to provide — optional peers excluded, kit or not. */
async function requiredPeers(projectDir: string, workerDir: string, pkg: string): Promise<Record<string, string>> {
  const base = await installedPackageBase(projectDir, workerDir, pkg);
  if (base === null) return {};
  const raw = await readOptionalFile(join(base, "node_modules", ...pkg.split("/"), "package.json"));
  if (raw === null) return {};
  const manifest = JSON.parse(raw) as {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  return Object.fromEntries(
    Object.entries(manifest.peerDependencies ?? {}).filter(
      ([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
    ),
  );
}
