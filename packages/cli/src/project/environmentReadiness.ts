// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { type ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { formatList } from "../terminal/output";
import type { AddressStanza } from "./workerAddress";
import { readWranglerConfig } from "./wrangler";

/**
 * Which of a project's declared environments a capability provisioner can act on right now — and what to
 * say about the ones it cannot.
 *
 * ## The defect this replaced
 *
 * Six capability provisioners (`email`, `media`, `payments`, `storage`, `support`, `testers`) fan out
 * across every declared environment, and every one of them carried its own copy of the same closure: read
 * the app Worker's `wrangler.jsonc`, find the `DB` binding for this environment, and **throw** when it has
 * no `database_id`. Six expressions of one rule, and the rule was the wrong one.
 *
 * It was wrong in two ways at once. The check fired *inside* the fan-out, from `deployWorker`, so a run
 * had already created every environment's bucket, namespace and secret before the first unprovisioned
 * environment was noticed — a deliberately staging-only bring-up failed part way through, naming
 * production, having already made production resources. And it was fatal at all, when *this environment
 * has no app database yet* is the ordinary state of a project standing staging up to prove it before
 * production exists. `pithy provision --env <name>` respects that ordering and `pithy deploy --env <name>`
 * respects it; capability provisioning was the step that did not (pithy-sh/pithy#512).
 *
 * ## The rule now
 *
 * An environment with no app `DB` `database_id` is **skipped**, not fatal, and the decision is made once,
 * before anything is created, from one read of one file. The command hands the orchestrator
 * {@link EnvironmentReadiness.ready} and reports {@link EnvironmentReadiness.skipped}, so no orchestrator
 * learns the word "skipped" and every project-global resource — the email suppression database, the
 * support bucket — is still created on the first run however many environments skip.
 *
 * A skip is the third outcome and never renders as a success: each one names **why** and **the command
 * that resolves it**, in text and in `--json` alike, which is what lets an operator answer *did production
 * get its email worker* without reading the Cloudflare account. `docs/CLI.md` §5.6 sets the same
 * vocabulary for `doctor`.
 *
 * ## What stays a refusal
 *
 * A **missing `env.<name>` stanza** is not a skip. An environment the project declares and the Worker's
 * config has never heard of is config drift, not provisioning state: `pithy provision --env <name>` does
 * not create the stanza, so skipping would put an environment in a state no command moves it out of.
 * `pithy doctor` reports the same drift, and this refuses by name.
 */

/** The slice of a wrangler env stanza a capability provisioner reads. Address fields included — email resolves one. */
export interface EnvStanza extends AddressStanza {
  d1_databases?: { binding: string; database_id?: string }[];
}

/** A wrangler config, reduced to its environment stanzas. The top-level document is the `dev` stanza. */
interface WranglerConfig extends EnvStanza {
  env?: Record<string, EnvStanza | undefined>;
}

/** One environment that is ready — its app database id, and the stanza the id came out of. */
export interface ReadyStanza {
  /** The `DB` binding's `database_id` for this environment. Present by construction: absent is what skips. */
  appDatabaseId: string;
  /** The whole stanza, for a caller that reads more than the database id (email resolves the public address). */
  stanza: EnvStanza;
}

/** One environment that was skipped, with the two sentences an operator needs. */
export interface SkippedEnvironment {
  /** The environment nothing was provisioned for. */
  env: ManagedEnvironment;
  /** Why it was skipped, as a sentence. */
  reason: string;
  /** The command that resolves it, as a sentence. */
  action: string;
}

/** The partition of a project's declared environments into what can be provisioned and what cannot. */
export interface EnvironmentReadiness {
  /** The `wrangler.jsonc` the decision was read from — named in every message about it. */
  path: string;
  /** Every declared environment, in declaration order — the order the report reads in. */
  declared: ManagedEnvironment[];
  /** Every ready environment, in declaration order. This is the list the orchestrator fans out across. */
  ready: ManagedEnvironment[];
  /** Every skipped environment, in declaration order. Reported; never silently dropped. */
  skipped: SkippedEnvironment[];
  /** The resolved stanza per ready environment — read once here rather than again per phase. */
  stanzas: ReadonlyMap<ManagedEnvironment, ReadyStanza>;
}

/**
 * The app database id in one stanza, or `null` when this environment has not been provisioned yet.
 *
 * **The empty string is `null`, and that is the case this predicate exists for.** A half-written stanza
 * does not omit the key — `"database_id": ""` is what a hand-edited `wrangler.jsonc` and a half-finished
 * `pithy provision` both leave behind, and it is the exact value the refusal this replaced treated as
 * unprovisioned (`if (!appDatabaseId)`, six times over). A truthiness check read as `!== undefined` would
 * invert the change for the case it most matters: the environment whose id was never filled in would count
 * as ready, be provisioned, and be reported as deployed — a Worker bound to a database that is not there,
 * announced as a success.
 */
function appDatabaseId(stanza: EnvStanza): string | null {
  const id = stanza.d1_databases?.find((database) => database.binding === "DB")?.database_id;
  return id === undefined || id === "" ? null : id;
}

/**
 * Partition a project's declared environments by whether their app database exists yet.
 *
 * One read, one parse, before anything is created — so the answer costs nothing and cannot disagree with
 * itself between phases. `support` used to re-read and re-parse this file once per environment per phase.
 */
export async function environmentReadiness(options: {
  /** The Worker directory holding the `wrangler.jsonc` that carries the per-environment `DB` binding. */
  workerDir: string;
  /** How that file is named in prose — `api's wrangler.jsonc` for a resolved Worker, else `wrangler.jsonc`. */
  label: string;
  /** The project's declaration from the root `pithy.config.ts`, in order. */
  environments: DeclaredEnvironments | readonly string[];
}): Promise<EnvironmentReadiness> {
  const path = join(options.workerDir, "wrangler.jsonc");
  const config = (await readWranglerConfig(options.workerDir)) as WranglerConfig;
  const ready: ManagedEnvironment[] = [];
  const skipped: SkippedEnvironment[] = [];
  const stanzas = new Map<ManagedEnvironment, ReadyStanza>();

  for (const env of managedEnvironments(options.environments)) {
    const stanza = config.env?.[env];
    if (!stanza) {
      throw new ValidationError({
        message: `${options.label} has no env.${env} stanza.`,
        action: `Add the ${env} environment to ${path} with its DB binding.`,
      });
    }
    const id = appDatabaseId(stanza);
    if (id === null) {
      skipped.push({
        env,
        reason: `env.${env} has no DB database_id.`,
        action: `Run pithy provision --env ${env}.`,
      });
      continue;
    }
    ready.push(env);
    stanzas.set(env, { appDatabaseId: id, stanza });
  }

  return { path, declared: managedEnvironments(options.environments), ready, skipped, stanzas };
}

/**
 * The same partition, narrowed to a subset of the declared environments.
 *
 * For the one command that already takes `--env` (`pithy testers`). Narrowing after the fact rather than
 * reading the file twice keeps one decision per run: the flag says which environments the operator meant,
 * readiness says which of those can be acted on, and the report still distinguishes the two.
 */
export function narrowReadiness(
  readiness: EnvironmentReadiness,
  environments: readonly ManagedEnvironment[],
): EnvironmentReadiness {
  const wanted = new Set(environments);
  const declared = readiness.declared.filter((env) => wanted.has(env));
  const ready = readiness.ready.filter((env) => wanted.has(env));
  return {
    path: readiness.path,
    declared,
    ready,
    skipped: readiness.skipped.filter((entry) => wanted.has(entry.env)),
    stanzas: new Map(ready.map((env) => [env, readyStanza(readiness, env)])),
  };
}

/**
 * The resolved stanza for a ready environment.
 *
 * Absent is impossible by construction — a provisioner only ever sees {@link EnvironmentReadiness.ready} —
 * so this is a bug check rather than an operator-facing refusal.
 */
export function readyStanza(readiness: EnvironmentReadiness, env: ManagedEnvironment): ReadyStanza {
  const found = readiness.stanzas.get(env);
  if (!found) throw new InternalError({ message: `The ${env} environment was skipped and has no app database.` });
  return found;
}

/** One skipped environment as the outcome half of a report line: why, then what to run. */
function skippedOutcome(entry: SkippedEnvironment): string {
  return `skipped — ${entry.reason} ${entry.action}`;
}

/**
 * Every declared environment paired with what happened to it, **in declaration order** — a skip reads as a
 * skip and a provisioned environment reads as whatever the command did for it.
 *
 * Declaration order rather than ready-then-skipped, because the operator reads this list against the one
 * in their `pithy.config.ts`; regrouping it by outcome makes the two disagree and hides which environment
 * is missing. `outcome` is only ever asked about a ready environment.
 */
export function environmentOutcomes(
  readiness: EnvironmentReadiness,
  outcome: (env: ManagedEnvironment) => string,
): { env: string; outcome: string }[] {
  const skips = new Map(readiness.skipped.map((entry) => [entry.env, entry]));
  return readiness.declared.map((env) => {
    const skip = skips.get(env);
    return { env, outcome: skip ? skippedOutcome(skip) : outcome(env) };
  });
}

/**
 * The per-environment block every capability provisioning command closes with — one indented line per
 * environment, its outcome beside it, padded to the longest name.
 *
 * One aggregate count cannot distinguish *deployed* from *skipped*, which is the whole question the
 * operator has (#512). Empty in — no environments at all — is an empty string, never a stray blank line.
 */
export function formatEnvironmentOutcomes(rows: readonly { env: string; outcome: string }[]): string {
  if (rows.length === 0) return "";
  const list = formatList(rows.map((row) => ({ name: row.env, description: row.outcome })));
  return `${list
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}\n`;
}

/**
 * Refuse a run in which **every** environment was skipped.
 *
 * Nothing was provisioned, and reporting success for a run that did nothing is the failure mode
 * skip-and-report would otherwise introduce — the operator would read `Done.` and believe production has a
 * worker. Exit 1, naming which environments were skipped, why, and the command that resolves the first of
 * them. Call it **after** the report is written, so `--json` still carries the per-environment structure on
 * stdout beside the `{"error":…}` line on stderr.
 */
export function requireReadyEnvironments(readiness: EnvironmentReadiness, command: string): void {
  if (readiness.ready.length > 0) return;
  const names = readiness.skipped.map((entry) => entry.env);
  const first = names[0];
  throw new ValidationError({
    message: `No environment is ready — ${names.join(" and ")} ${names.length === 1 ? "has" : "have"} no DB database_id.`,
    action: `Run pithy provision --env ${first} to create its app database, then run ${command} again.`,
    detail: `${readiness.path}: no DB database_id for ${names.join(", ")}`,
  });
}
