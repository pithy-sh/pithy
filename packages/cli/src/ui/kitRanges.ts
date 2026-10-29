// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedVersionFrom } from "../kitPackages/plan";
import { fetchPackument } from "../kitPackages/registry";
import { readOptionalFile } from "../project/readOptionalFile";
import { kitRange } from "../project/scaffold";

/**
 * The range an app's `package.json` declares for each kit package its templates import.
 *
 * Every package a written template imports gets a range, whatever the Worker beside it composes: an app whose
 * screens import `@pithy-sh/auth` for its client types does not typecheck until auth is installed. Asked in order,
 * and the first answer wins: the Worker's own range, so the app and the Worker run one release; the project
 * root's; the version installed under the project, or beside this CLI; the registry's `latest`. A package none of
 * them answers for is reported, never guessed.
 */

/** A kit package named by an import specifier: `@pithy-sh/auth/src/client/api` is `@pithy-sh/auth`. */
const KIT_IMPORT = /\bfrom\s+"(@pithy-sh\/[a-z0-9-]+)(?:\/[^"]*)?"/g;

/** Every kit package the files' sources import, sorted. Only `.ts` and `.tsx` files are read. */
export function importedKitPackages(files: Readonly<Record<string, string>>): string[] {
  const found = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (!/\.tsx?$/.test(path)) continue;
    for (const match of text.matchAll(KIT_IMPORT)) if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

/** Where the ranges are looked for. */
export interface KitRangeSources {
  projectDir: string;
  /** The backend Worker's directory, whose `package.json` is asked first. */
  workerDir: string;
  /** Directories whose `node_modules` chain is asked for an installed copy. Defaults to the project and this CLI. */
  installedFrom?: readonly string[];
  /** The registry's `latest` for a package, or `null`. Defaults to the npm registry. */
  latest?: (name: string) => Promise<string | null>;
}

/** The ranges found, and the packages nothing answered for. */
export interface KitRanges {
  ranges: Record<string, string>;
  unresolved: string[];
}

/** Every range a manifest declares, dependencies over devDependencies. Empty when it is absent or unreadable. */
async function declared(dir: string): Promise<Record<string, unknown>> {
  const raw = await readOptionalFile(join(dir, "package.json"));
  if (raw === null) return {};
  try {
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return { ...pkg.devDependencies, ...pkg.dependencies };
  } catch {
    return {};
  }
}

/** The npm registry's `latest`, or `null` when it does not answer. */
async function registryLatest(name: string): Promise<string | null> {
  return (await fetchPackument(name))?.["dist-tags"].latest ?? null;
}

/** The range for each of `names`, from the first source that has one. */
export async function kitRangesFor(names: readonly string[], sources: KitRangeSources): Promise<KitRanges> {
  const manifests = [await declared(sources.workerDir), await declared(sources.projectDir)];
  const installedFrom = sources.installedFrom ?? [sources.projectDir, dirname(fileURLToPath(import.meta.url))];
  const latest = sources.latest ?? registryLatest;
  const ranges: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const name of names) {
    const written = manifests.map((manifest) => manifest[name]).find((range) => typeof range === "string");
    if (typeof written === "string") {
      ranges[name] = written;
      continue;
    }
    let range: string | null = null;
    for (const dir of installedFrom) {
      const version = await installedVersionFrom(dir, name);
      range = version === null ? null : kitRange(version);
      if (range !== null) break;
    }
    if (range === null) {
      const version = await latest(name);
      range = version === null ? null : kitRange(version);
    }
    if (range === null) unresolved.push(name);
    else ranges[name] = range;
  }
  return { ranges, unresolved };
}
