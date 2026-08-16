// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { EncryptionConfig } from "../crypto/envelope";
import type { SecretsTables } from "../data/tables";
import type { ConfigWriter } from "../manager/configWriter";
import type { RotationTracker } from "../store/rotationTracker";
import { countOnOldKeys, mergeNextKey, pruneOldKeys, reencryptBatch } from "./keyRotation";

type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/** The sentinel name a whole-store at-rest key rotation is recorded under in `pithy_secrets_rotations`. */
export const AT_REST_ROTATION_NAME = "__at_rest_key_rotation__";

/**
 * A durable step runner — the structural subset of Cloudflare's `WorkflowStep` we use. The
 * Workflow class passes the real runtime step; tests pass a synchronous mock that runs each
 * callback immediately. Keeping it structural avoids a hard dependency on `cloudflare:workers`.
 */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** Everything the at-rest rotation needs, injected so the core is testable without CF wiring. */
export interface AtRestRotationDeps {
  /** The per-environment secrets D1. */
  db: SecretsDb;
  /** The current master-key config (resolved from `SECRETS_ENCRYPTION_KEYS`). */
  config: EncryptionConfig;
  /** Writes the updated config back to CF Secrets Store. */
  configWriter: ConfigWriter;
  /** Records the rotation attempt in `pithy_secrets_rotations`. */
  tracker: RotationTracker;
}

export interface AtRestRotationOptions {
  batchSize?: number;
  maxBatches?: number;
  rotatedBy?: string;
  /**
   * The clock, for a test that wants a fixed one.
   *
   * Read **inside** the `pass-instant` step rather than beside it, so journalling this value did not
   * close the seam: an injected clock is still what gets read and still what gets journalled.
   */
  now?: Date;
}

export interface AtRestRotationResult {
  rotated: number;
  failed: number;
  newCurrentVersion: number;
  pruned: boolean;
}

/**
 * Rotate the at-rest encryption key for one environment's store, in durable steps:
 *
 *   1. open a rotation row (`in_progress`);
 *   2. generate a fresh master key, merge it as the new current version, and persist the config;
 *   3. re-encrypt every row to the new key, in batches, until none remain (or `maxBatches`);
 *   4. once no row references an old key, prune the old keys and persist again;
 *   5. close the rotation row (`success`, or `failed` on any throw, which re-raises).
 *
 * Each step is retryable and idempotent: re-encryption only touches rows not yet on the current
 * version, and the old key stays available until pruning, so a mid-run retry is safe. Scoped to one
 * environment — the per-env manager owns one store; cross-env fan-out is the CLI's job.
 */
export async function runAtRestKeyRotation(
  deps: AtRestRotationDeps,
  step: StepRunner,
  options: AtRestRotationOptions = {},
): Promise<AtRestRotationResult> {
  const batchSize = options.batchSize ?? 100;
  const maxBatches = options.maxBatches ?? 50;
  const rotatedBy = options.rotatedBy ?? "cron";

  /**
   * The pass instant, journalled (pithy-sh/pithy#329).
   *
   * A Workflow re-executes this body from the top on a resume and serves every completed step from the
   * journal, so a clock read beside this line answers differently on every attempt. It is the instant
   * written as `lastRotatedAt`, and a pass interrupted at midnight and resumed at six dated the key it
   * rotated by the resume — a rotation history that cannot be reconciled against the work it names.
   *
   * **This one is a stamp and nothing else, and that was checked rather than assumed.** `lastRotatedAt`
   * has one reader, `isRotationDue`, which asks a cadence question in days on a cron that starts nothing
   * while an instance is live; the rotation row's `startedAt`/`completedAt` are written by
   * `RotationTracker` inside its own steps and read only for display. So freezing this instant strands no
   * running work. The sibling case in the email worker looked equally plain and was not — there `now` is
   * the scheduler's heartbeat too, and freezing it lets a live batch be re-driven as stuck.
   *
   * Epoch milliseconds rather than a `Date`, because a journal round-trips JSON: a `Date` would come back
   * a string on the resume and an object on the first pass.
   */
  const nowMs: number = await step.do("pass-instant", async () => (options.now ?? new Date()).getTime());
  const now = new Date(nowMs);

  const rotationId = await step.do("start", () => deps.tracker.startRotation(AT_REST_ROTATION_NAME, "cron", rotatedBy));

  try {
    const newConfig = await step.do("generate-key", () => mergeNextKey(deps.config, now));
    await step.do("write-config", async () => {
      await deps.configWriter.write(JSON.stringify(newConfig));
    });

    let rotated = 0;
    let failed = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const result = await step.do(`reencrypt-${batch}`, () => reencryptBatch(deps.db, newConfig, batchSize));
      rotated += result.rotated;
      failed += result.failed;
      // Stop when a batch makes no progress — either the store is fully rotated, or only
      // failures remain (which would loop forever).
      if (result.rotated === 0) break;
    }

    let pruned = false;
    const remaining = await step.do("count-remaining", () => countOnOldKeys(deps.db, newConfig));
    if (remaining === 0) {
      const prunedConfig = pruneOldKeys(newConfig);
      if (prunedConfig) {
        await step.do("prune", async () => {
          await deps.configWriter.write(JSON.stringify(prunedConfig));
        });
        pruned = true;
      }
    }

    await step.do("mark-success", () => deps.tracker.markSuccess(rotationId));
    return { rotated, failed, newCurrentVersion: Number(newConfig.currentVersion), pruned };
  } catch (cause) {
    // **The binding rethrows and does nothing else (`#386`).** It used to become the row's `error_message`
    // via `cause.message`, and the exceptions that reach here come from decryption, envelope decoding and
    // config parsing — the paths whose text can carry key material. `markFailure` now takes a code and
    // renders the sentence itself, so there is no argument this `cause` would fit.
    //
    // Rethrown unchanged, which is where the detail belongs: the Workflow logs a `PithyError` whose
    // `detail` the HTTP codec strips. Nothing about this failure is written to a column, and the column
    // is still refused for publication — that refusal is defence in depth, not this fix.
    await step.do("mark-failure", () => deps.tracker.markFailure(rotationId, "at-rest-incomplete"));
    throw cause;
  }
}
