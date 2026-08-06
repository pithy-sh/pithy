// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { writeFileAtomic } from "../project/atomic";
import type { WorkerConfig } from "../project/config";
import { alreadyProvided, execArgs, type PackageManager } from "../project/packageManager";
import { DEV_PORT_TOKEN } from "../project/workerManifest";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { deriveWorkerFirst } from "./routeAllowlist";
import type { UiStub } from "./stubs";
import { readManifestDocument, writeManifestDocument } from "./workerUi";

/**
 * The three files `pithy ui` edits rather than creates: the worker's `wrangler.jsonc` (how the built
 * assets are served), its `pithy.worker.jsonc` (how `pithy dev` runs it and `pithy deploy` builds it),
 * and its `package.json` (the stub's packages and scripts).
 *
 * All three are edited in place and comment-preserving. comment-json keeps an adopter's notes as
 * symbol-keyed properties on the very object or array they hang off, so a replaced array is a
 * deleted comment — every update below mutates what is already there.
 */

/** The `assets` slice of a worker's `wrangler.jsonc`. */
interface AssetsStanza {
  not_found_handling?: string;
  run_worker_first?: string[];
}

/** What {@link wireAssets} changed — the before/after `pithy ui sync` reports. */
export interface AssetsChange {
  /** The previous `run_worker_first`, or `null` when there was no `assets` stanza at all. */
  before: string[] | null;
  /** The derived allowlist now in the file. */
  after: string[];
  /** `not_found_handling` as it stands now — written when absent, left alone when the adopter set it. */
  notFoundHandling: string | undefined;
  /** True when this call wrote `not_found_handling`, so a report can say the file moved. */
  wroteNotFoundHandling: boolean;
}

/** SPA routing: a request matching no asset is answered with `index.html` rather than a 404. */
const SPA_NOT_FOUND = "single-page-application";

/**
 * The `assets` stanza as the file currently holds it, without touching it — what `pithy ui sync
 * --check` reads. A missing stanza, or a `run_worker_first` that is not an array, both come back as an
 * empty list: neither is a list this Worker is relying on.
 *
 * Separate from {@link wireAssets} rather than a flag on it, because a check that can write is a check
 * nobody can run twice for the same answer.
 */
export async function readAssets(workerDir: string): Promise<{ runWorkerFirst: string[]; notFoundHandling?: string }> {
  const document = (await readWranglerConfig(workerDir)) as { assets?: AssetsStanza };
  const assets = document.assets;
  return {
    runWorkerFirst: Array.isArray(assets?.run_worker_first) ? [...assets.run_worker_first] : [],
    ...(assets?.not_found_handling === undefined ? {} : { notFoundHandling: assets.not_found_handling }),
  };
}

/**
 * Write the `assets` stanza into a worker's `wrangler.jsonc`.
 *
 * `assets.directory` is deliberately **not** written. Under the Vite plugin it is supplied by the
 * plugin, which overwrites whatever is there without complaining — so a `directory` in the adopter's
 * config would be a line that looks authoritative and is not.
 *
 * `not_found_handling` is written only when **absent**. The allowlist is derived and must be
 * re-derived on every sync; `not_found_handling` is a routing choice, and once the file has one it is
 * the adopter's. Overwriting it on every `pithy ui sync` would silently undo a deliberate change —
 * create-never-overwrite applied to a value rather than a file.
 *
 * Idempotent: re-running rewrites the same derived list. That is exactly what `pithy ui sync` is,
 * which is why the derivation and the write live together.
 */
export async function wireAssets(workerDir: string, config: WorkerConfig): Promise<AssetsChange> {
  const patterns = deriveWorkerFirst(config);
  const document = (await readWranglerConfig(workerDir)) as { assets?: AssetsStanza };

  const existing = document.assets;
  let before: string[] | null = null;
  if (existing) before = Array.isArray(existing.run_worker_first) ? [...existing.run_worker_first] : [];

  const assets: AssetsStanza = existing ?? {};
  const wroteNotFoundHandling = assets.not_found_handling === undefined;
  if (wroteNotFoundHandling) assets.not_found_handling = SPA_NOT_FOUND;
  if (Array.isArray(assets.run_worker_first)) {
    // In place: the array object carries the adopter's comments.
    assets.run_worker_first.splice(0, assets.run_worker_first.length, ...patterns);
  } else {
    assets.run_worker_first = patterns;
  }
  document.assets = assets;

  await writeWranglerConfig(workerDir, document);
  return {
    before,
    after: patterns,
    notFoundHandling: assets.not_found_handling,
    wroteNotFoundHandling,
  };
}

/**
 * Write the `dev` and `ui` blocks into a worker's `pithy.worker.jsonc`.
 *
 * `dev.command` is a full argv — the manifest has no package-manager concept — so the stub's
 * package-manager-agnostic argv is resolved here through the adopter's `execArgs`: `bun x vite dev …`
 * for a Bun project, `npx vite dev …` for an npm one. `{port}` stays a placeholder; `pithy dev`
 * substitutes the feature's pinned port at spawn time, because ports are assigned at feature
 * creation and never probed at startup.
 *
 * `ui.build` stays package-manager-agnostic: `pithy deploy` runs it through the same `execArgs` at
 * build time, where it also knows the environment.
 */
export async function wireManifest(workerDir: string, stub: UiStub, packageManager: PackageManager): Promise<void> {
  const document = await readManifestDocument(workerDir);

  const dev: Record<string, unknown> = (document.dev as Record<string, unknown> | undefined) ?? {};
  const [bin, ...rest] = stub.devCommand(DEV_PORT_TOKEN);
  if (!bin) {
    throw new InternalError({
      message: `The ${stub.id} stub declares an empty dev command.`,
      action: "This is a Pithy bug. Report it at https://github.com/pithy-sh/pithy/issues.",
    });
  }
  const { command, args } = execArgs(packageManager, bin, rest);
  dev.autostart = true;
  dev.readySignal = stub.readySignal;
  dev.command = [command, ...args];
  document.dev = dev;

  const ui: Record<string, unknown> = (document.ui as Record<string, unknown> | undefined) ?? {};
  ui.stub = stub.id;
  ui.build = [...stub.buildCommand];
  document.ui = ui;

  await writeManifestDocument(workerDir, document);
}

/**
 * The one script value `pithy ui add` replaces. Pithy wrote it into every scaffolded worker, and
 * serving the worker through Vite supersedes it — leaving it would hand the adopter a `bun run dev`
 * that starts the API without the UI. Any other value is the adopter's and is kept.
 */
const REPLACEABLE_DEV_SCRIPT = "wrangler dev";

/** A worker's `package.json`, in the shape this module merges into. */
interface WorkerPackage {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Add every missing key from `incoming`; never touch one that is already there. */
function mergeMissing(target: Record<string, string>, incoming: Record<string, string>): string[] {
  const added: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (key in target) continue;
    target[key] = value;
    added.push(key);
  }
  return added;
}

/**
 * Drop every package the project already provides, so no unresolvable range is written.
 *
 * The stub pins `"@pithy-sh/vite": "^0.0.0"`, and nothing under that scope is published — against a local
 * checkout the range 404s on the adopter's *next* install, long after `pithy ui add` said Done. The
 * package resolves from the project root either way, so omitting the line costs nothing and the build
 * still finds it. Same predicate `pithy add` skips its install on ({@link alreadyProvided}).
 */
async function withoutProvided(projectDir: string, packages: Record<string, string>): Promise<Record<string, string>> {
  const kept: Record<string, string> = {};
  for (const [name, range] of Object.entries(packages)) {
    if (await alreadyProvided(projectDir, name)) continue;
    kept[name] = range;
  }
  return kept;
}

/** What {@link wirePackage} added, for the command's report. */
export interface PackageChange {
  /** Dependency names newly added (an existing pin is never touched, so never downgraded). */
  dependencies: string[];
  /** Dev-dependency names newly added. */
  devDependencies: string[];
  /** Script names newly added or, for `dev`, superseded. */
  scripts: string[];
}

/**
 * Merge the stub's packages and scripts into `apps/<worker>/package.json`.
 *
 * **Merge, never replace.** Every existing key survives, which also means an existing pin is never
 * downgraded: a dependency already declared keeps whatever version the adopter chose. The single
 * exception is the `dev` script when it still holds Pithy's own scaffolded `wrangler dev` — see
 * {@link REPLACEABLE_DEV_SCRIPT}.
 *
 * `projectDir` is the root, not the worker: it is where the packages resolve from, and a `@pithy-sh/*`
 * one that already does gets no range written for it — see {@link withoutProvided}.
 */
export async function wirePackage(projectDir: string, workerDir: string, stub: UiStub): Promise<PackageChange> {
  const path = join(workerDir, "package.json");
  let pkg: WorkerPackage;
  try {
    pkg = JSON.parse(await readFile(path, "utf8")) as WorkerPackage;
  } catch (cause) {
    throw new InternalError({
      message: `Could not read ${path}.`,
      action: "Every worker under apps/ needs a package.json. pithy worker add creates one.",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};
  pkg.scripts ??= {};

  const dependencies = mergeMissing(pkg.dependencies, await withoutProvided(projectDir, stub.dependencies));
  const devDependencies = mergeMissing(pkg.devDependencies, await withoutProvided(projectDir, stub.devDependencies));

  if (pkg.scripts.dev === REPLACEABLE_DEV_SCRIPT) delete pkg.scripts.dev;
  const scripts = mergeMissing(pkg.scripts, stub.scripts);

  await writeFileAtomic(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return { dependencies, devDependencies, scripts };
}
