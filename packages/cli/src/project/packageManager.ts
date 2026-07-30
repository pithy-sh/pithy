// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";

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
 * Install a package with the project's detected package manager. Returns which
 * manager ran, so `pithy add` can report it. The adopter's PM is always used —
 * Bun stays a dev-only signal, never a requirement of adoption.
 */
export async function installPackage(options: InstallPackageOptions): Promise<{ packageManager: PackageManager }> {
  const packageManager = await detectPackageManager(options.projectDir);
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

/**
 * Uninstall a package with the project's detected package manager — the inverse of {@link installPackage},
 * behind `pithy remove`. Returns which manager ran. The adopter's PM is always used.
 */
export async function uninstallPackage(options: UninstallPackageOptions): Promise<{ packageManager: PackageManager }> {
  const packageManager = await detectPackageManager(options.projectDir);
  await (options.run ?? spawnInstall)(packageManager, uninstallArgs(packageManager, options.pkg), options.projectDir);
  return { packageManager };
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
