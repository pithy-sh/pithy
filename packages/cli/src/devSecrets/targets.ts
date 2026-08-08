// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { isSecretsCapability } from "@pithy-sh/secrets/src/capability";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { aggregateSecretRegistries } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { loadWorkerConfig, type WorkerConfig } from "../project/config";
import { resolveWorkers } from "../project/workerScope";
import { ownProperties } from "./records";

/**
 * Which Workers a dev-secrets run acts on, and the registry each one resolves secrets through.
 *
 * **Its own module, because both ends of the run need it and one of them is upstream of the other.**
 * `pithy seed` needs the targets to know where a `d1` value goes; the generator needs them to know which
 * `cf-secrets-store` secrets to materialise into each Worker's `.dev.vars` (#179). With this in the
 * seeder, the generator importing it closed a cycle — generator → seeder → writer → generator — and the
 * answer to "which Workers, with which registry" is neither of their business to own privately.
 */

/** One Worker's contribution: its name, its directory, and the registry that decides its destinations. */
export interface DevSecretsTarget {
  /** The Worker's name — what a skipped reason names, so the adopter knows which one to fix. */
  name: string;
  /** The Worker's directory; its `wrangler.jsonc` declares the `SECRETS` binding. */
  dir: string;
  /** That Worker's secret registry. */
  registry: SecretRegistry;
}

/**
 * Every Worker in the project that composes `secrets`, with the registry that Worker actually resolves
 * secrets through. A Worker without the capability is not an error and not a target — it has no
 * `SECRETS` store to seed into, so there is nothing to do and nothing to say about it.
 *
 * **The registry is the aggregate, not the secrets capability's own slice.** `aggregateSecretRegistries`
 * is the exact call the Worker makes at composition: every capability contributes the secrets it owns,
 * and `auth-session-secret` is auth's declaration, not something an adopter re-types into
 * `secrets({ registry })`. Reading only the secrets capability's slice seeded nothing in a real project
 * and threw outright in a scaffolded one, where `pithy add secrets` writes `secrets({ rotationIntervalDays })`
 * and leaves `registry` for the adopter — so the slice is `undefined` on a config the CLI itself wrote.
 */
export async function devSecretsTargets(
  projectDir: string,
  options: DevSecretsTargetsOptions = {},
): Promise<DevSecretsTarget[]> {
  const workers = await resolveWorkers({
    projectDir,
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
    ...(options.reload ? { loadConfig: reloadWorkerConfig } : {}),
  }).catch(() => []);
  const targets: DevSecretsTarget[] = [];
  for (const resolved of workers) {
    if (!resolved.capabilities.some(isSecretsCapability)) continue;
    targets.push({
      name: resolved.name,
      dir: resolved.dir,
      // Prototype-free, so `registry[name]` here and in every consumer — `pithy doctor` included — is an
      // own-property lookup for a secret a capability chose to call `constructor`. See {@link ownProperties}.
      registry: ownProperties(aggregateSecretRegistries(resolved.capabilities)),
    });
  }
  return targets;
}

/** How {@link devSecretsTargets} narrows and how it loads. Both default to the whole project, cached. */
export interface DevSecretsTargetsOptions {
  /** Narrow to one Worker, by the name `pithy worker list` shows or its `apps/<dir>` basename. */
  worker?: string;
  /**
   * Re-import each `pithy.config.ts` rather than taking the module this process already holds.
   *
   * For **`pithy add`, and only for it.** That command rewrites the Worker's config and then seeds, in
   * one process that imported the config before the write — so the aggregate registry it seeds against
   * is the composition from *before* the add, and the secret the same run has just minted never
   * reaches the store. The next unrelated command picked it up, which made it look like a store
   * problem rather than a stale module.
   *
   * Off by default because it is not free: every reload adds a module instance to the ESM registry for
   * the life of the process, and re-runs the config's top-level code. `pithy dev` and `pithy seed` load
   * the config once and never rewrite it, so they have nothing stale to correct.
   */
  reload?: boolean;
  /** **Unsayable on purpose (#159).** Targets are the project's own Workers; there is no environment. */
  env?: never;
}

/** Distinguishes one reload from the next, so two in a process both get a module and not the first one twice. */
let reloadCount = 0;

/**
 * One Worker's `pithy.config.ts`, imported past the ESM module cache with a query the resolver ignores
 * and the cache key does not.
 *
 * **The specifier is the absolute path, not `pathToFileURL`, and that is load-bearing under Bun.** Bun
 * honours the query as part of the cache key for a path specifier and ignores it for a `file://` URL:
 * `import("/abs/pithy.config.ts?v=2")` re-evaluates, `import("file:///abs/pithy.config.ts?v=2")` hands
 * back the first instance. The URL form is what {@link loadWorkerConfig} uses and is right there — it
 * *wants* the cache. Written the same way here, `pithy add auth` seeded nothing and said nothing about
 * it, because the fallback below silently returned the stale module. Vitest's module runner busts on
 * either form, so no unit test can tell the two apart; the CLI itself was what caught it.
 *
 * Every failure falls back to {@link loadWorkerConfig}, which owns the two actionable errors — a config
 * that is absent, and one that will not import — so nothing here has to restate them, and a config that
 * loads clean but exports the wrong shape is answered by the same message it always was.
 */
async function reloadWorkerConfig(workerDir: string): Promise<WorkerConfig> {
  const path = join(workerDir, "pithy.config.ts");
  reloadCount += 1;
  const module = await import(`${path}?pithy-reload=${reloadCount}`).catch(() => null);
  const config: unknown = module?.default;
  if (config === null || typeof config !== "object" || !Array.isArray((config as WorkerConfig).capabilities)) {
    return loadWorkerConfig(workerDir);
  }
  return config as WorkerConfig;
}
