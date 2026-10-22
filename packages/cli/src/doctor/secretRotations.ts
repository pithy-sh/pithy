// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { FIELD_KEYS_BINDING } from "@pithy-sh/core/src/crypto/fieldKeys";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { readSecretStatus } from "@pithy-sh/secrets/src/admin/status";
import { FIELD_KEY_ROTATION_NAME } from "@pithy-sh/secrets/src/data/secretRotations";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { type RotationFailureCode, rotationFailureCodeOf } from "@pithy-sh/secrets/src/rotation/rotationLedger";
import { aggregateSecretRegistries } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { RotationTracker } from "@pithy-sh/secrets/src/store/rotationTracker";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { readProjectDatabases, unprovisionedDatabases, type WorkerScope } from "../migrations/run";
import type { RemoteSkip } from "./environmentMigrations";

/**
 * **The `Secret rotations:` line — a rotation that failed, in each deployed environment (#602).**
 *
 * A secret that declares `rotateEveryDays` is rotated by its environment's secrets manager at 03:00 UTC,
 * with nobody watching. A rotation that fails there is recorded in that environment's ledger — and until
 * this line, the only way to learn of it was to read the ledger. So doctor reads it: for every secret the
 * project declares, whether the newest closed attempt failed, when, and why as a code.
 *
 * **A code, never the ledger's text.** The read is `readSecretStatus` with `failures: true` — the same read
 * the control-plane status route publishes — so what this line can say is exactly what a management client
 * can, and nothing a failure site wrote reaches the terminal.
 *
 * **It reports and never fails the exit**, like the secret tables line beside it. The remedy depends on the
 * code — `not-recorded` needs a human at the issuer now, `not-rotated` is retried on the next tick,
 * `not-retired` waits on a dependent — and none of them is a command doctor could name for every case.
 */

/** One secret whose newest closed rotation attempt failed. */
export interface FailedRotation {
  /** The secret's registry name. */
  name: string;
  /** When the failed attempt closed, ISO-8601. */
  at: string;
  /** Why, as a code. `null` when the ledger holds a failure in words this release does not write. */
  reason: RotationFailureCode | null;
}

/** One environment's answer. */
export type EnvironmentSecretRotations =
  | {
      /** The environment this answer is about. */
      env: string;
      /** The ledger answered. */
      state: "read";
      /** Secrets whose newest closed attempt failed, by name. */
      failed: FailedRotation[];
    }
  | { env: string /** The stanza names no `SECRETS` database. */; state: "not-provisioned" }
  | { env: string /** A deployed read that was not attempted. */; state: "skipped"; reason: RemoteSkip }
  | { env: string /** The read threw; nothing of what it threw is kept. */; state: "unreadable" }
  | { env: string /** A Worker's `pithy.config.ts` threw for this environment. */; state: "not-composed" };

/** What the check established. */
export type SecretRotationsState = "ok" | "not-applicable" | "could-not-check" | "findings";

/** What `doctor` learned about the project's rotations. */
export interface SecretRotationsCheck {
  state: SecretRotationsState;
  /** One answer per declared environment. */
  environments: EnvironmentSecretRotations[];
}

/** One Worker as this check addresses it. */
export interface SecretRotationsWorker {
  name: string;
  dir: string;
}

/** Options for {@link checkSecretRotations}. */
export interface SecretRotationsOptions {
  /** The project root. */
  projectDir: string;
  /** Every declared environment. `dev` has no manager and no cron, so it is never asked. */
  environments: readonly string[];
  /** The project's Workers. */
  workers: readonly SecretRotationsWorker[];
  /** The Cloudflare account this project belongs to, or `null`. */
  account: CloudflareAccountSelection | null;
  /** Why a deployed read will not be attempted this run, or `null` when it will. */
  remoteSkip: RemoteSkip | null;
  /** Composition seam — the compositions doctor's report already took. */
  composeWorker: (worker: SecretRotationsWorker, env: string) => Promise<{ capabilities: readonly Capability[] }>;
  /** Ledger seam. Defaults to {@link readFailedRotations}. */
  readLedger?: (env: string, workers: WorkerScope[], registry: SecretRegistry) => Promise<FailedRotation[]>;
}

/**
 * Every declared secret whose newest closed attempt failed, across every `secrets` database in scope — one per
 * environment in practice. Read-only, and through the status read, so nothing but a name, an instant and a
 * code can come back.
 */
export async function readFailedRotations(
  options: { projectDir: string; env: string; account: CloudflareAccountSelection | null; workers: WorkerScope[] },
  registry: SecretRegistry,
): Promise<FailedRotation[]> {
  const reads = await readProjectDatabases(
    { projectDir: options.projectDir, env: options.env, account: options.account, workers: options.workers },
    "secrets",
    (d1) => readSecretStatus(createDatabase(d1, secretsTables), registry, { failures: true }),
  );
  const failed: FailedRotation[] = [];
  // **The field key's own ledger row (#390).** Recorded under a sentinel no registry declares, so the status read
  // above never lists it. A version still live when the next rotation came due closes the pass failed, and that is
  // the one rotation finding this report treats as an error ({@link fieldKeyRotationErrors}).
  const fieldKey = await readProjectDatabases(
    { projectDir: options.projectDir, env: options.env, account: options.account, workers: options.workers },
    "secrets",
    (d1) => RotationTracker.fromD1(d1).lastClosed(FIELD_KEY_ROTATION_NAME),
  );
  for (const read of fieldKey) {
    const last = read.value;
    if (last === null || last.status !== "failed" || last.completedAt === null) continue;
    failed.push({
      name: FIELD_KEYS_BINDING,
      at: last.completedAt.toISOString(),
      reason: rotationFailureCodeOf(last.errorMessage),
    });
  }
  for (const read of reads) {
    for (const entry of read.value) {
      if (entry.state !== "readable" || !entry.status.lastFailure) continue;
      failed.push({
        name: entry.status.name,
        at: entry.status.lastFailure.at.toISOString(),
        reason: entry.status.lastFailure.reason,
      });
    }
  }
  return failed;
}

/** The registry every Worker composing `secrets` reads, merged — what the ledger is reported over. */
function composedRegistry(workers: readonly WorkerScope[]): SecretRegistry {
  const composing = workers.filter((worker) => worker.capabilities.some((capability) => capability.name === "secrets"));
  return aggregateSecretRegistries(composing.flatMap((worker) => worker.capabilities));
}

/**
 * Answer every declared environment. **Never throws**: every way it can fail is one of the states above.
 * Composition first, because it decides whether there is a registry to report over; provisioning from files
 * second; the skip third; the read last.
 */
export async function checkSecretRotations(options: SecretRotationsOptions): Promise<SecretRotationsCheck> {
  const readLedger =
    options.readLedger ??
    ((env: string, workers: WorkerScope[], registry: SecretRegistry) =>
      readFailedRotations({ projectDir: options.projectDir, env, account: options.account, workers }, registry));

  let composesSecrets = false;
  let composedAnywhere = false;
  const environments: EnvironmentSecretRotations[] = [];
  for (const env of options.environments) {
    let workers: WorkerScope[];
    let registry: SecretRegistry;
    try {
      workers = await Promise.all(
        options.workers.map(async (worker) => ({
          name: worker.name,
          dir: worker.dir,
          capabilities: [...(await options.composeWorker(worker, env)).capabilities],
        })),
      );
      registry = composedRegistry(workers);
    } catch {
      environments.push({ env, state: "not-composed" });
      continue;
    }
    composedAnywhere = true;
    if (Object.keys(registry).length === 0) continue;
    composesSecrets = true;

    const unprovisioned = await unprovisionedDatabases(env, workers).catch(() => []);
    if (unprovisioned.some((database) => database.binding === "SECRETS")) {
      environments.push({ env, state: "not-provisioned" });
      continue;
    }
    if (options.remoteSkip !== null) {
      environments.push({ env, state: "skipped", reason: options.remoteSkip });
      continue;
    }
    try {
      environments.push({ env, state: "read", failed: await readLedger(env, workers, registry) });
    } catch {
      environments.push({ env, state: "unreadable" });
    }
  }

  // Whether a project composes `secrets` is answered by any environment that composed: a config that throws
  // under `prod` beside a `staging` with no registry is a project with nothing that rotates, and its failure is
  // the `Environment configs:` block's to report. Only a config that composed nowhere leaves the question open.
  if (!composesSecrets && composedAnywhere) {
    return { state: "not-applicable", environments: [] };
  }
  // An environment with no vault yet has no ledger and nothing that could have rotated, so it is a fact rather
  // than a gap: a project not yet provisioned reads `ok`, not `could-not-check` on every run.
  const state: SecretRotationsState = environments.some((answer) => answer.state === "read" && answer.failed.length > 0)
    ? "findings"
    : environments.every((answer) => answer.state === "read" || answer.state === "not-provisioned")
      ? "ok"
      : "could-not-check";
  return { state, environments };
}

/**
 * The command that rights one environment's answer — `pithy doctor --json`'s `fix` — and there is none.
 *
 * Not an omission. A failed rotation's remedy is in its code: `not-recorded` and `roll-failed` are a human at
 * the issuer, `not-rotated` is the next scheduled tick, `not-retired` is a dependent re-encrypting on its next
 * request. Naming `pithy secrets rotate` here would roll a credential on the strength of a report line, which
 * is the one act this kit never takes on anyone's behalf.
 */
export function secretRotationsFix(_answer: EnvironmentSecretRotations): null {
  return null;
}

/** The field-key codes that are an error, not a finding: the guard has held a version a whole period, or a fourth. */
const FIELD_KEY_ERRORS: ReadonlySet<RotationFailureCode> = new Set(["field-key-overdue", "field-key-ceiling"]);

/**
 * **The one rotation finding that fails the exit (#390): a field-key version still live at the next rotation.**
 * Retirement is lazy and a dirty guard is a backlog for one period, but a version the guard held a whole period is a
 * failure the rotator cannot clear by itself, and the next step is a person's — fix what the guard names, or retire
 * it past the guard. One sentence per environment it was read in.
 */
export function fieldKeyRotationErrors(check: SecretRotationsCheck): string[] {
  const errors: string[] = [];
  for (const answer of check.environments) {
    if (answer.state !== "read") continue;
    for (const failure of answer.failed) {
      if (failure.name !== FIELD_KEYS_BINDING || failure.reason === null || !FIELD_KEY_ERRORS.has(failure.reason)) {
        continue;
      }
      errors.push(
        `${answer.env}: ${REASON[failure.reason]}. Read the secrets manager's audit events for what holds it, then fix it, or retire the version past the guard with ${commandName("secrets retire-version")} at a terminal`,
      );
    }
  }
  return errors;
}

/** What each code means for an operator, in one clause. Every code the ledger can hold has one. */
const REASON: Record<RotationFailureCode, string> = {
  "roll-failed": "the rotator never answered, so whether the issuer rolled is unknown — check the issuer now",
  "not-recorded": "the issuer rolled and the store did not take the value — the old credential is dead, act now",
  "not-rotated": "nothing was rolled or written, and the previous value is still live — the next tick retries",
  "at-rest-incomplete": "the at-rest key rotation did not finish",
  "at-rest-unconfirmed": "the at-rest key rotation could not confirm its write through the binding",
  "not-retired": "rotated, and the previous version is kept until what is sealed under it is re-encrypted",
  "field-key-overdue": "a field-key version was still live when the next rotation came due",
  "field-key-ceiling": "the field-key rotation was refused at four live versions",
  "field-key-unconfirmed": "the field-key rotation could not confirm its write through the binding",
  "field-key-incomplete": "the field-key rotation did not finish",
};

/** The block's lines: one per environment, and one more per failed rotation. */
export function describeSecretRotations(check: SecretRotationsCheck): string[] {
  const lines: string[] = [];
  for (const answer of check.environments) {
    switch (answer.state) {
      case "read":
        if (answer.failed.length === 0) {
          lines.push(`${answer.env}: no failed rotation.`);
          break;
        }
        lines.push(
          `${answer.env}: ${answer.failed.length} ${answer.failed.length === 1 ? "secret's" : "secrets'"} last rotation failed.`,
        );
        for (const failure of answer.failed) {
          const why = failure.reason === null ? "for a reason this release does not record" : REASON[failure.reason];
          lines.push(`  ${failure.name} — ${failure.at.slice(0, 10)}: ${why}.`);
        }
        break;
      case "not-provisioned":
        lines.push(
          `${answer.env}: not provisioned — env.${answer.env} has no SECRETS database_id, so there is no ledger to read.`,
        );
        break;
      case "skipped":
        lines.push(
          answer.reason === "offline"
            ? `${answer.env}: skipped — offline, so no ledger was read.`
            : `${answer.env}: skipped — no Cloudflare credentials, so no ledger was read.`,
        );
        break;
      case "unreadable":
        lines.push(`${answer.env}: could not be read, so whether a rotation failed is unknown.`);
        break;
      case "not-composed":
        lines.push(`${answer.env}: pithy.config.ts did not compose for ${answer.env}, so no ledger was read.`);
        break;
    }
  }
  return lines;
}
