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

/** The install argv for a package manager: npm `install`, the rest `add`. */
export function installArgs(pm: PackageManager, pkg: string): string[] {
  return [pm === "npm" ? "install" : "add", pkg];
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
