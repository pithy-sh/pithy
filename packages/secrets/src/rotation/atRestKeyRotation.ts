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

  const rotationId = await step.do("start", () => deps.tracker.startRotation(AT_REST_ROTATION_NAME, "cron", rotatedBy));
  /**
   * The rotation's clock, journalled — read in a step, read back from the step on resume.
   *
   * This body re-executes from the top when the run resumes, so an unjournalled read would stamp the new key
   * version with whenever the retry happened rather than when the rotation began. A caller who supplies
   * `options.now` gets theirs; the step is what makes either answer survive a replay (#331).
   */
  const nowMs: number = await step.do("rotation-clock", async () => (options.now ?? new Date()).getTime());
  const now = new Date(nowMs);

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
    const message = cause instanceof Error ? cause.message : String(cause);
    await step.do("mark-failure", () => deps.tracker.markFailure(rotationId, message));
    throw cause;
  }
}
