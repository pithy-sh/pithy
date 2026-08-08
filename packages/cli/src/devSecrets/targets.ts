// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { isSecretsCapability } from "@pithy-sh/secrets/src/capability";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { aggregateSecretRegistries } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { loadWorkerConfig, type WorkerConfig } from "../project/config";
import { resolveWorkers } from "../project/workerScope";
import { discoverWorkers } from "../project/workers";
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

/** A Worker that has a `pithy.config.ts` and could not be asked what it declares. Never a value. */
export interface UnresolvableWorker {
  /** The Worker's name — what the report names, so the adopter knows which config to fix. */
  name: string;
  /** The Worker's directory. Its `.dev.vars` is the file that went without. */
  dir: string;
  /** Why the config did not import, already actionable. Reaches a terminal, so never `detail`. */
  reason: string;
}

/**
 * Which Workers declare secrets, **and which ones could not be asked** — the two answers that must not
 * arrive as one (#199).
 *
 * **An array cannot say "and this one is broken", which is the whole defect.** `resolveWorkers` throws
 * for a config that is present and will not import, deliberately: swallowing it prints "No workers here"
 * for a project that plainly has workers. {@link devSecretsTargets} caught that throw into `[]` — and
 * `[]` is also what a project that never composed `secrets` returns. So every consumer read a config
 * that would not load as a Worker that declares nothing. Since #179 that is not a cosmetic conflation:
 * a `cf-secrets-store` secret is materialised only from the registry, so an empty registry means the
 * generated `.dev.vars` is written down to its header and the Worker starts with **no bindings at all**.
 * `pithy dev` did exactly that and printed `Starting replay-board.` and nothing else.
 *
 * Behaviour is unchanged and correct — a registry nobody can read has no honest answer, and the old
 * answer came from the `dev.json` copy #179 exists to delete. What changes is that the failure is now a
 * field rather than an absence, so a caller has to drop it on purpose instead of by taking the only
 * thing there was to take.
 *
 * **Resolved one Worker at a time, so a failure costs exactly one.** `resolveWorkers`' fan-out throws on
 * the first bad config, which took every healthy sibling's registry with it: a project with two Workers
 * lost both because one of them had a typo. Discovery happens once and the single-Worker path — the same
 * `pick`-then-load `resolveWorkers` already owns, seams included — is driven per target.
 *
 * **A missing `pithy.config.ts` is skipped, not reported.** A Vite frontend joining the dev set through
 * `pithy.worker.jsonc` alone has no config and declares nothing; that is the ordinary state, not a
 * failure, and reporting it would put a permanent warning in front of every project with a frontend.
 * Exactly `core/not_found`, which is the code {@link loadWorkerConfig} raises for the absent file and
 * nothing else — the same rule, and the same test, `resolveWorkers`' own loop applies.
 *
 * **The registry is the aggregate, not the secrets capability's own slice.** `aggregateSecretRegistries`
 * is the exact call the Worker makes at composition: every capability contributes the secrets it owns,
 * and `auth-session-secret` is auth's declaration, not something an adopter re-types into
 * `secrets({ registry })`. Reading only the secrets capability's slice seeded nothing in a real project
 * and threw outright in a scaffolded one, where `pithy add secrets` writes `secrets({ rotationIntervalDays })`
 * and leaves `registry` for the adopter — so the slice is `undefined` on a config the CLI itself wrote.
 */
export async function resolveDevSecretsTargets(
  projectDir: string,
  options: DevSecretsTargetsOptions = {},
): Promise<DevSecretsResolution> {
  // Never throws. A directory that is not a project has no workers, no secrets, and nothing to report —
  // `pithy add` runs this wherever the adopter is standing, and refusing there would fail a command that
  // has nothing to do. That is the one absence this module is still allowed to answer with silence.
  const discovered = await discoverWorkers(projectDir).catch(() => []);
  const scoped =
    options.worker === undefined
      ? discovered
      : discovered.filter((target) => target.name === options.worker || target.dir.endsWith(`/${options.worker}`));

  const targets: DevSecretsTarget[] = [];
  const unresolvable: UnresolvableWorker[] = [];
  for (const target of scoped) {
    const [resolved] = await resolveWorkers({
      projectDir,
      worker: target.name,
      // Discovery is already done; this hands `resolveWorkers` the one target so its single-Worker path
      // loads exactly this config and its failure belongs to exactly this Worker.
      discoverWorkers: async () => [target],
      ...(options.reload ? { loadConfig: reloadWorkerConfig } : {}),
    }).catch((error: unknown) => {
      if (error instanceof PithyError && error.payload.code === "core/not_found") return [];
      unresolvable.push({ name: target.name, dir: target.dir, reason: messageOf(error) });
      return [];
    });
    if (!resolved) continue;
    if (!resolved.capabilities.some(isSecretsCapability)) continue;
    targets.push({
      name: resolved.name,
      dir: resolved.dir,
      // Prototype-free, so `registry[name]` here and in every consumer — `pithy doctor` included — is an
      // own-property lookup for a secret a capability chose to call `constructor`. See {@link ownProperties}.
      registry: ownProperties(aggregateSecretRegistries(resolved.capabilities)),
    });
  }
  return { targets, unresolvable };
}

/** Both halves of one resolution: what declared secrets, and what could not be asked. */
export interface DevSecretsResolution {
  /** Every Worker that composes `secrets`, with the registry it resolves them through. */
  targets: DevSecretsTarget[];
  /** Every Worker with a `pithy.config.ts` that would not import, and why. Empty on an ordinary run. */
  unresolvable: UnresolvableWorker[];
}

/**
 * {@link resolveDevSecretsTargets}, minus the failures — **lossy on purpose, and only where recorded.**
 *
 * Kept because four callers legitimately have nothing to do with an unresolvable Worker: the three
 * `pithy doctor` checks, which are diagnostics running beside a project-health block that already names
 * the config that would not load, and `pithy add`. A tripwire in this module's test pins that list by
 * name, so a fifth caller has to add itself and read why — the alternative is the fifth caller quietly
 * repeating the conflation, which is how this defect class reached four producers in the first place.
 *
 * Prefer {@link resolveDevSecretsTargets} anywhere the answer decides what a Worker is given.
 */
export async function devSecretsTargets(
  projectDir: string,
  options: DevSecretsTargetsOptions = {},
): Promise<DevSecretsTarget[]> {
  return (await resolveDevSecretsTargets(projectDir, options)).targets;
}

/**
 * One actionable sentence from a thrown failure.
 *
 * `message` and `action` together, never `detail`: `detail` is throw-site context — for
 * {@link loadWorkerConfig} it is the raw module-resolution error — and these lines reach a terminal and
 * `logs/dev.log`.
 */
function messageOf(error: unknown): string {
  if (error instanceof PithyError) return `${error.payload.message} ${error.payload.action ?? ""}`.trim();
  return error instanceof Error ? error.message : String(error);
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
