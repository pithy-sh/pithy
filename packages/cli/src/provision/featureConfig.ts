// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { isAbsolute, join } from "node:path";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";

/**
 * **A feature's config is a build artifact, so it is not written where source lives.**
 *
 * A feature's ids could once land in `apps/<worker>/wrangler.jsonc` — a
 * tracked, committed file, and one that cannot be gitignored because it is the project's real config.
 * In CI that is correct as designed: the checkout is throwaway, wrangler reads the stanza, the job
 * ends, nothing is committed. Everywhere else it was an expectation rather than a guarantee. A
 * developer in a feature worktree carried a modified tracked file they had not edited, with nothing
 * saying it must not be committed; `git add -A` put ids for since-deleted resources onto `main`, and
 * `feature destroy` — which reverses every other thing provisioning did — did not reverse the edit.
 *
 * **The rule, and it is a shape rather than a warning: a CI run never writes a tracked file.** So the
 * feature's config is generated beside the Worker's, under `.wrangler/`, which every scaffolded
 * project has ignored since the first release and ignores at any depth. Nothing new to add to a
 * `.gitignore`, nothing for an existing project to adopt, and no `git add -A` that can reach it. It
 * also answers the question `destroy` could not: a feature abandoned without teardown leaves an ignored
 * file in a directory nothing reads, rather than a stranded edit to source.
 *
 * `main` is rewritten to an absolute path because wrangler resolves a config's paths relative to the
 * config file, and this one sits two directories deeper than the file it was generated from.
 */

/** Where the generated config for a feature environment lives, under the already-ignored `.wrangler/`. */
export function featureConfigPath(workerDir: string): string {
  return join(workerDir, ".wrangler", "pithy", "wrangler.feature.jsonc");
}

/**
 * The file a provisioning run writes one Worker's ids into: the tracked `wrangler.jsonc` when they are
 * source, the generated config when they are a build artifact.
 *
 * **One function, because the writer and the report have to agree.** `pithy provision` states the file it
 * wrote and whether it is committed, and a report naming one path while the writer edits another is worse
 * than no report at all — it is a note in a runbook contradicting the code. Both go through here, so
 * "which file?" is answered once, by `ProvisionScope.source`, which is also what answered "what is it
 * called?" and "which stanza?".
 */
export function provisionConfigPath(workerDir: string, source: boolean): string {
  return source ? join(workerDir, "wrangler.jsonc") : featureConfigPath(workerDir);
}

/**
 * The config file a command should read (or hand to wrangler) for one Worker and one environment.
 *
 * A feature environment resolves to the generated file; everything else to the Worker's own tracked
 * `wrangler.jsonc`. One resolver, so `migrate`, `seed` and `deploy` cannot disagree about which bytes
 * describe the environment they are acting on.
 */
export function wranglerConfigPath(workerDir: string, env: string): string {
  return provisionConfigPath(workerDir, isSourceEnvironment(env));
}

/**
 * Is this environment's config **source** — the tracked `wrangler.jsonc` — rather than a generated one?
 *
 * The same question `ProvisionScope.source` answers for a provisioning run, asked by a caller that has
 * only an environment name. One predicate rather than two comparisons against a literal, so a command
 * that starts handling feature environments cannot answer it differently from the writer.
 *
 * A project cannot declare `feature` as one of its environments, so the two answers can never both be
 * true of one name — `DeclaredEnvironments` refuses it for exactly this reason.
 */
export function isSourceEnvironment(env: string): boolean {
  return env !== FEATURE_ENVIRONMENT;
}

/** The path-valued fields wrangler resolves relative to the config file, and this file therefore rewrites. */
const RELATIVE_PATHS = ["main"] as const;

/**
 * Rewrite a generated config's relative paths against the directory it was generated *from*.
 *
 * Wrangler resolves `main` relative to the configuration file's own location, and the generated file
 * sits under `<worker>/.wrangler/pithy/`. Left alone, `"main": "src/index.ts"` would name a file that
 * does not exist and the deploy would fail on it — the exact class of quiet breakage this whole thread
 * is about, so it is fixed here rather than left to the first adopter to hit it.
 *
 * `assets.directory` gets the same treatment when a Worker carries a UI.
 */
export function absolutizePaths(config: Record<string, unknown>, workerDir: string): void {
  for (const key of RELATIVE_PATHS) {
    const value = config[key];
    if (typeof value === "string" && !isAbsolute(value)) config[key] = join(workerDir, value);
  }
  const assets = config.assets;
  if (assets && typeof assets === "object") {
    const directory = (assets as { directory?: unknown }).directory;
    if (typeof directory === "string" && !isAbsolute(directory)) {
      (assets as { directory?: unknown }).directory = join(workerDir, directory);
    }
  }
}
