// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConflictError, InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { promoteDependencies } from "../project/packageManager";

/**
 * The directory an ejected capability's source is copied into, relative to the Worker's
 * `pithy.config.ts` — so it lands in `apps/<worker>/capabilities/<cap>/`, beside the config that
 * imports it. Ejecting is per-Worker because the wiring it forks is per-Worker.
 */
export const EJECT_DIR = "capabilities";

/** The local import path an ejected capability is wired to — also the "this is ejected" signal for upgrade. */
export function ejectImportPath(capability: string): string {
  return `./${EJECT_DIR}/${capability}`;
}

/**
 * The capabilities a `pithy.config.ts` source has ejected — those imported from the local
 * `./capabilities/<name>` path rather than an `@pithy-sh/*` package. The local import **is** the
 * ejected signal: a future `pithy upgrade` reads this to skip forks (issue #33), since ejected code
 * no longer tracks the package.
 */
export function parseEjectedCapabilities(configSource: string): string[] {
  const names: string[] = [];
  // Match either quote style so a hand-reformatted config still reads as ejected.
  const pattern = /from\s+["']\.\/capabilities\/([^"'/]+)(?:\/[^"']*)?["']/g;
  for (const match of configSource.matchAll(pattern)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Read a Worker's `pithy.config.ts` and return the ejected capability names (empty if the file is
 * unreadable). `workerDir` is `apps/<name>` — the config that wires the capability is the one that says
 * whether it was forked.
 */
export async function ejectedCapabilities(workerDir: string): Promise<string[]> {
  try {
    return parseEjectedCapabilities(await readFile(join(workerDir, "pithy.config.ts"), "utf8"));
  } catch {
    return [];
  }
}

/** Whether a specific capability has been ejected in this Worker. */
export async function isEjected(workerDir: string, capability: string): Promise<boolean> {
  return (await ejectedCapabilities(workerDir)).includes(capability);
}

/** Promote a forked capability's runtime deps into the project. Injected in tests. */
export type PromoteDeps = (projectDir: string, deps: string[]) => Promise<void>;

export interface EjectCapabilityOptions {
  /** The project root — where `package.json`, the lockfile, and `node_modules` live. */
  projectDir: string;
  /** The Worker's directory (`apps/<name>`) — its `pithy.config.ts`, and where the fork lands. */
  workerDir: string;
  /** The capability's short name, e.g. `auth` — the local directory and import leaf. */
  capability: string;
  /** The capability's package, e.g. `@pithy-sh/auth` — the source and manifest to read. */
  package: string;
  /** Overwrite an existing local copy, discarding the user's edits. Off by default (refuses). */
  force?: boolean;
  /** Promote the package's runtime deps; defaults to the detected package manager. */
  promoteDeps?: PromoteDeps;
}

/** What eject did: where the source landed and which deps it promoted. */
export interface EjectResult {
  capability: string;
  /** The Worker-relative directory the source was copied into (`capabilities/<cap>`). */
  path: string;
  /** The `name@version` deps promoted into the project (workspace-internal ones excluded). */
  promotedDependencies: string[];
  /** Whether an existing local copy was overwritten (`--force`). */
  forced: boolean;
}

/** True if a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The package's promotable runtime dependencies as `name@version`, read from the installed manifest.
 * Workspace-internal versions (`workspace:*`) are dropped — they exist only inside this monorepo and a
 * published package never carries them; an adopter's install resolves them to real ranges.
 */
async function promotableDependencies(projectDir: string, pkg: string): Promise<string[]> {
  let dependencies: Record<string, string>;
  try {
    const raw = await readFile(join(projectDir, "node_modules", pkg, "package.json"), "utf8");
    dependencies = (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies ?? {};
  } catch (cause) {
    throw new InternalError({
      message: `Couldn't read ${pkg}'s package.json to promote its dependencies.`,
      action: `Reinstall ${pkg}, then eject again.`,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return Object.entries(dependencies)
    .filter(([, version]) => !version.startsWith("workspace:"))
    .map(([name, version]) => `${name}@${version}`);
}

/** Repoint the managed-region import from the package to the local copy; idempotent if already local. */
async function repointImport(workerDir: string, pkg: string, capability: string): Promise<void> {
  const path = join(workerDir, "pithy.config.ts");
  const source = await readFile(path, "utf8");
  const packageSpecifier = `"${pkg}/src/index"`;
  const localSpecifier = `"${ejectImportPath(capability)}"`;
  if (source.includes(packageSpecifier)) {
    await writeFile(path, source.replace(packageSpecifier, localSpecifier));
    return;
  }
  if (source.includes(localSpecifier)) return; // already ejected — a --force re-copy leaves it local
  throw new NotFoundError({
    message: `${path} doesn't import ${pkg}.`,
    action: `Run pithy add ${capability} first, then eject.`,
  });
}

/**
 * Eject a capability into **one Worker**: copy its entire installed `src/` into
 * `apps/<worker>/capabilities/<cap>/`, repoint that Worker's `pithy.config.ts` import at the local copy,
 * and promote the package's runtime deps into the project so the copy builds standalone. The capability
 * is now the user's — nothing from `@pithy-sh/<cap>` is imported and it no longer upgrades (the
 * principle-3 trade). Another Worker that wires the same capability keeps the package; a fork is scoped
 * to the Worker that asked for it. Refuses to overwrite an existing local copy unless `force` is set;
 * `force` removes it first so stale files don't linger.
 */
export async function ejectCapability(options: EjectCapabilityOptions): Promise<EjectResult> {
  const { projectDir, workerDir, capability, package: pkg, force } = options;
  const source = join(projectDir, "node_modules", pkg, "src");
  const dest = join(workerDir, EJECT_DIR, capability);

  if (!(await exists(source))) {
    throw new NotFoundError({
      message: `${pkg} is not installed (no ${pkg}/src to eject).`,
      action: `Run pithy add ${capability} first.`,
    });
  }

  const alreadyEjected = await exists(dest);
  if (alreadyEjected && !force) {
    throw new ConflictError({
      message: `${EJECT_DIR}/${capability} already exists.`,
      action: "Edit the local copy, or re-run with --force to overwrite it (discards your changes).",
    });
  }
  if (alreadyEjected) await rm(dest, { recursive: true, force: true });

  // Order matters for a clean failure: copy the source, promote its deps, and only then repoint the
  // config. If promotion fails, the config still imports the working package rather than a local copy
  // whose dependencies were never installed.
  await cp(source, dest, { recursive: true });

  const promotedDependencies = await promotableDependencies(projectDir, pkg);
  const promote = options.promoteDeps ?? ((dir, deps) => promoteDependencies(dir, deps).then(() => {}));
  await promote(projectDir, promotedDependencies);

  await repointImport(workerDir, pkg, capability);

  return { capability, path: `${EJECT_DIR}/${capability}`, promotedDependencies, forced: Boolean(alreadyEjected) };
}
