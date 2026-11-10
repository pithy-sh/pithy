// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { isBuiltin } from "node:module";
import { join, sep } from "node:path";
import { staticImportSpecifiers } from "../capabilities/configImports";
import { readSource, sourcePaths } from "../ci/sourceFiles";
import { writeFileAtomic } from "./atomic";
import { syncLockfile } from "./packageManager";
import { readOptionalFile } from "./readOptionalFile";
import { workspaceMembers } from "./workspaceMembers";

/**
 * **A package a root config imports is declared by the root.**
 *
 * The project-root configs (`vitest.workers.config.ts`) load from the root, and under a package manager that does
 * not hoist (Bun's isolated linker, pnpm) the root resolves only what the root's own `package.json` declares. A
 * Worker's declaration of the same package links it beside that Worker and nowhere else. So every CLI write of a
 * root config goes through {@link writeRootConfig}, which declares each package the config imports as a root
 * `devDependency` at the range a workspace member declares it at, and takes that declaration out again once no
 * file that resolves through the root imports the package. The Worker's runtime dependency is never touched.
 */

/** Bring the lockfile in step after the root `package.json` changed. */
export type LockfileSync = (projectDir: string) => Promise<void>;

/**
 * The package a bare import specifier resolves through: `@scope/name` or `name`. `null` for a relative or absolute
 * path, a subpath import (`#…`), a URL scheme such as `node:` or `cloudflare:test`, and a Node builtin.
 */
export function packageOfSpecifier(specifier: string): string | null {
  if (/^[./#]/.test(specifier) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return null;
  const segments = specifier.split("/");
  if (specifier.startsWith("@"))
    return segments.length < 2 || segments[1] === "" ? null : `${segments[0]}/${segments[1]}`;
  const name = segments[0] ?? "";
  return name === "" || isBuiltin(name) ? null : name;
}

/** Each package a source's static imports resolve through, once, in first-import order. */
export function importedPackages(source: string): string[] {
  const packages = staticImportSpecifiers(source)
    .map(packageOfSpecifier)
    .filter((pkg): pkg is string => pkg !== null);
  return [...new Set(packages)];
}

/** A `package.json` as this module reads one. */
interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The fields a package manager links a declared package from. */
const DECLARING_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

function declares(manifest: Manifest, pkg: string): boolean {
  return manifest.name === pkg || DECLARING_FIELDS.some((field) => manifest[field]?.[pkg] !== undefined);
}

/** The range the first workspace member declaring `pkg` declares it at, or `undefined` when none does. */
export async function memberRange(projectDir: string, pkg: string): Promise<string | undefined> {
  for (const member of await workspaceMembers(projectDir)) {
    const raw = await readOptionalFile(join(projectDir, member, "package.json"));
    if (raw === null) continue;
    const manifest = JSON.parse(raw) as Manifest;
    const range = manifest.dependencies?.[pkg] ?? manifest.devDependencies?.[pkg];
    if (range !== undefined) return range;
  }
  return undefined;
}

/** A script or config file, whose imports a package manager resolves. */
const SOURCE = /\.[cm]?[jt]sx?$/;

/**
 * Whether any file that resolves packages through the root `package.json` imports `pkg`: one in the project root,
 * or under a root directory that is not a workspace member (`scripts/`, `test/`). A workspace member resolves
 * through its own `package.json`, so nothing under one counts.
 */
async function rootImports(projectDir: string, pkg: string): Promise<boolean> {
  const members = (await workspaceMembers(projectDir)).filter((member) => member !== ".");
  const underMember = (path: string) => {
    const relative = path
      .slice(projectDir.length + 1)
      .split(sep)
      .join("/");
    return members.some((member) => relative.startsWith(`${member}/`));
  };
  for (const path of sourcePaths(projectDir, { keep: (name) => SOURCE.test(name) })) {
    if (underMember(path)) continue;
    const source = readSource(path);
    if (source !== null && importedPackages(source).includes(pkg)) return true;
  }
  return false;
}

/** The root `devDependencies` one {@link writeRootConfig} wrote in and took out. */
export interface RootDependencyChange {
  /** The packages declared as root `devDependencies`, in import order. */
  added: string[];
  /** The root `devDependencies` taken out, in the order the config had imported them. */
  removed: string[];
}

/** One write of a project-root config. */
export interface RootConfigWrite {
  /** The project root. */
  projectDir: string;
  /** The config's path from the project root. */
  file: string;
  /** The config as it was read. */
  original: string;
  /** The config to write. Equal to `original`, the file is left alone and the root is still reconciled. */
  source: string;
  /** Run after the root `package.json` changed (default: {@link syncLockfile}). */
  sync?: LockfileSync;
}

function sorted(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Write a project-root config, and keep the root `package.json` declaring what it imports. A package it imports
 * that the root does not declare becomes a root `devDependency`, sorted, at the range a workspace member declares it
 * at; one no member declares has no range to write and is left for `pithy doctor` to name. A package the config
 * stopped importing loses its root `devDependency` once no file that
 * resolves through the root imports it, a root script under `scripts/` included. A root runtime dependency is
 * never taken out. When the root `package.json` changed, `sync` brings the lockfile in step.
 */
export async function writeRootConfig(write: RootConfigWrite): Promise<RootDependencyChange> {
  const { projectDir, file, original, source } = write;
  if (source !== original) await writeFileAtomic(join(projectDir, file), source);
  const unchanged: RootDependencyChange = { added: [], removed: [] };
  const path = join(projectDir, "package.json");
  const raw = await readOptionalFile(path);
  if (raw === null) return unchanged;
  const root = JSON.parse(raw) as Manifest & Record<string, unknown>;
  const devDependencies = { ...(root.devDependencies ?? {}) };

  const imported = importedPackages(source);
  const added: string[] = [];
  for (const pkg of imported) {
    if (declares(root, pkg)) continue;
    const range = await memberRange(projectDir, pkg);
    if (range === undefined) continue;
    devDependencies[pkg] = range;
    added.push(pkg);
  }

  const removed: string[] = [];
  for (const pkg of importedPackages(original).filter((candidate) => !imported.includes(candidate))) {
    if (devDependencies[pkg] === undefined || (await rootImports(projectDir, pkg))) continue;
    delete devDependencies[pkg];
    removed.push(pkg);
  }

  if (added.length === 0 && removed.length === 0) return unchanged;
  if (Object.keys(devDependencies).length === 0) delete root.devDependencies;
  else root.devDependencies = sorted(devDependencies);
  await writeFileAtomic(path, `${JSON.stringify(root, null, 2)}\n`);
  await (write.sync ?? syncLockfile)(projectDir);
  return { added, removed };
}
