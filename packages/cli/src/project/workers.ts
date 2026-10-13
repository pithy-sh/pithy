// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "comment-json";
import { defaultWorkerDev, parseWorkerManifest, WORKER_MANIFEST_FILE, type WorkerDev } from "./workerManifest";

/** A discovered Worker: its deploy name, its directory, its dev-set settings, and whether it is a real Worker. */
export interface WorkerTarget {
  /** The Worker's name — its `wrangler.jsonc` `name`, or the directory when that is absent. */
  name: string;
  /** The directory holding the Worker's `wrangler.jsonc`/`pithy.worker.jsonc` — the `cwd` for wrangler. */
  dir: string;
  /**
   * How `pithy dev` runs this worker locally, from `pithy.worker.jsonc` (or a synthesized default). Real
   * discovery always sets it; it is optional so the many test doubles that only need `name`/`dir` stay valid.
   */
  dev?: WorkerDev;
  /** Whether the directory holds a `wrangler.jsonc`. `false` → a non-Worker process (deploy skips it). */
  hasWrangler?: boolean;
}

/** Just the `name` field of a `wrangler.jsonc` — the Worker's deployed name. */
interface NamedWrangler {
  name?: string;
}

/** True if `dir` holds a file named `file`. */
function hasFile(dir: string, file: string): boolean {
  try {
    return statSync(join(dir, file)).isFile();
  } catch {
    return false;
  }
}

/** One directory under `apps/` that discovery counts as a Worker, and whether it holds a `wrangler.jsonc`. */
interface WorkerDirectory {
  /** The directory. */
  dir: string;
  /** Its name under `apps/`, which is what `--worker` takes. */
  entry: string;
  /** Whether it holds a `wrangler.jsonc`. */
  hasWrangler: boolean;
}

/**
 * **The discovery rule, once**: every `apps/<name>/` holding a `pithy.worker.jsonc` or a `wrangler.jsonc`, by
 * directory name. Synchronous, so a classifier building a sentence inside a `catch` reads the same set
 * {@link discoverWorkers} does, by the same test (#711).
 */
function workerDirectories(projectDir: string): WorkerDirectory[] {
  let entries: string[];
  try {
    entries = readdirSync(join(projectDir, "apps"));
  } catch {
    return [];
  }
  const found: WorkerDirectory[] = [];
  for (const entry of [...entries].sort()) {
    const dir = join(projectDir, "apps", entry);
    const hasWrangler = hasFile(dir, "wrangler.jsonc");
    if (hasWrangler || hasFile(dir, WORKER_MANIFEST_FILE)) found.push({ dir, entry, hasWrangler });
  }
  return found;
}

/**
 * **The Workers `pithy add --worker` can wire into**, by directory, sorted by its name: discovered, and carrying a
 * `pithy.config.ts`. A dev-only process composes nothing and is no `--worker` target. Every sentence that offers
 * one command per Worker reads its Workers here.
 */
export function configuredWorkerDirs(projectDir: string): string[] {
  return workerDirectories(projectDir)
    .filter((found) => hasFile(found.dir, "pithy.config.ts"))
    .map((found) => found.dir);
}

/** The Worker's name from its `wrangler.jsonc`, falling back to `fallback` if unreadable or unnamed. */
async function workerName(dir: string, fallback: string): Promise<string> {
  try {
    const config = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as NamedWrangler;
    return config.name ?? fallback;
  } catch {
    return fallback;
  }
}

/** Build a {@link WorkerTarget} for `dir`, reading its manifest (or synthesizing a default dev block). */
async function toTarget(dir: string, fallbackName: string, hasWrangler: boolean): Promise<WorkerTarget> {
  const manifest = await parseWorkerManifest(dir);
  return {
    name: hasWrangler ? await workerName(dir, fallbackName) : fallbackName,
    dir,
    dev: manifest?.dev ?? defaultWorkerDev(),
    hasWrangler,
  };
}

/**
 * The project's Workers. `apps/` **is** the registry (`docs/CLI.md` §6): every `apps/<name>/` carrying a
 * `pithy.worker.jsonc` **or** a `wrangler.jsonc` is one Worker. Discovery keys on `pithy.worker.jsonc` so a
 * non-Worker process (a Vite frontend with no `wrangler.jsonc`) can still join the dev set; a `wrangler.jsonc`
 * with no manifest is still discovered with a synthesized autostart dev block.
 *
 * **There is no root Worker.** Every Worker lives in `apps/<name>/` with its own `wrangler.jsonc` and its own
 * `pithy.config.ts`, so capabilities, bindings, and Durable Object class migrations attach to the Worker that
 * actually owns them. `dev`, `deploy`, `migrate`, `seed`, `upgrade`, and `doctor` all discover the set this
 * way — no hand-kept list, and nothing special-cases the project root.
 */
export async function discoverWorkers(projectDir: string): Promise<WorkerTarget[]> {
  const workers: WorkerTarget[] = [];
  for (const found of workerDirectories(projectDir)) {
    workers.push(await toTarget(found.dir, found.entry, found.hasWrangler));
  }
  return workers.sort((a, b) => a.name.localeCompare(b.name));
}
