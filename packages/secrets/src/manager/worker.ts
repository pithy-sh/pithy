// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareSecretsStoreManager } from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
import { RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import { remedy } from "@pithy-sh/core/src/cli/command";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { AT_REST_ROTATION_NAME } from "../data/secretRotations";
import { resolveEncryptionConfig, type SecretBinding, type SecretsStoreEnv } from "../env/bindings";
import { atRestInstanceId } from "../rotation/atRestKeyRotation";
import { FieldKeyCommand, type FieldKeyReport } from "../rotation/fieldKeyRotation";
import { isRotationDue } from "../rotation/keyRotation";
import { rotationBackedOff } from "../rotation/rotationLedger";
import type { ManagedEnvironment } from "../scope";
import { configureSharedSecrets, sharedSecretsStore } from "../sharedSecretsStore";
import { RotationTracker } from "../store/rotationTracker";
import { logAuditEmit } from "./auditLog";
import { type FieldKeyEnv, runFieldKeyWorkflow, scheduleFieldKeyRotation } from "./fieldKeyWorkflow";
import { managerRegistry } from "./managerRegistry";
import { secretsWorkflowRetry } from "./retryPolicy";
import { runRotationWorkflow } from "./rotationWorkflow";
import { fieldKeysConfigWriter, rotationConfigWriter } from "./secretsConfigWriter";
import {
  runValueRotationWorkflow,
  scheduleValueRotations,
  type ValueRotationEnv,
  type ValueRotationPayload,
} from "./valueRotationWorkflow";
import { runWriteWorkflow, type WriteWorkflowPayload, type WriteWorkflowResult } from "./writeWorkflow";

/**
 * The prebuilt per-environment secrets manager worker. `pithy add secrets` deploys one per managed
 * environment (`<project>-staging-secrets`, `<project>-prod-secrets`); the user authors no code for it.
 * It hosts four Workflows and a cron:
 *
 *   - `SecretsWriteWorkflow` — the CLI's dispatch target for create/update/remove.
 *   - `AtRestKeyRotationWorkflow` — re-encrypts the store under a fresh master key.
 *   - `SecretValueRotationWorkflow` — replaces one secret's value on its declared period, waits out its
 *     overlap, and retires the version it replaced (#602).
 *   - `FieldKeyRotationWorkflow` — rotates the field key app Workers seal encrypted fields with, re-seals what
 *     is leaving, and retires it on a clean guard (#390).
 *   - `scheduled()` — fires the at-rest rotation when its interval has elapsed, and a value rotation for
 *     every secret whose `rotateEveryDays` has.
 *
 * The Workflow bodies (`runWriteWorkflow`, `runRotationWorkflow`) are tested against Miniflare; these
 * classes are the thin durable-execution shells over them. This module imports `cloudflare:workers`,
 * so it runs only in the Workers runtime (excluded from the node meta-test).
 */

const DEFAULT_ROTATION_INTERVAL_DAYS = 30;

// This is a standalone worker, not assembled by `createBackend`, so its `compose` hook never runs.
// Configure the shared per-invocation accessor directly from the manager's own registry, so reads go
// through the one cached path (a rotation run reads the runtime token once) like every other worker.
configureSharedSecrets({ registry: managerRegistry });

/** The manager worker's env: the secrets D1 + key binding, the rotation Workflow bindings, CF creds for the write-back. */
export interface SecretsManagerEnv extends SecretsStoreEnv, ValueRotationEnv, FieldKeyEnv {
  /**
   * The at-rest rotation Workflow binding, triggered by the cron.
   *
   * `create` takes an id, and the cron always passes one: two overlapping passes silently destroy a store,
   * and Cloudflare refusing a duplicate instance id costs the second trigger nothing to find that out. It
   * is the cheap half. The id carries a UTC day, so two triggers either side of midnight compose two of
   * them — what makes a second pass impossible rather than unlikely is `RotationTracker.claimRotation`,
   * which opens this pass's ledger row only where the sentinel holds no open one. See
   * {@link atRestInstanceId}.
   */
  AT_REST_ROTATION: { create(options?: { id?: string }): Promise<unknown> };
  /**
   * The application's one Cloudflare API token (#728), for the at-rest config write-back — the only
   * live-CF write. A `cf-secrets-store` binding read via
   * `sharedSecretsStore(env, managerRegistry).get(RUNTIME_TOKEN_SECRET)`, a string from `.dev.vars` in
   * local dev. Never a plaintext env var.
   */
  RUNTIME_CF_API_TOKEN: SecretBinding | string;
  CLOUDFLARE_ACCOUNT_ID: string;
  SECRETS_STORE_ID: string;
  /**
   * This manager's environment. The rotation write-back uses it to target the project- and env-scoped
   * master-key store entry — the same entry the `SECRETS_ENCRYPTION_KEYS` binding reads — so a rotation
   * persists to the entry the worker actually binds. Filled at provision from `managedEnvironments()`;
   * still `ManagedEnvironment.parse`d at the read site, since a wrangler var is external config.
   */
  ENVIRONMENT: ManagedEnvironment;
  /**
   * This manager's project — the other half of the master-key entry name
   * (`<project>-<env>-secrets-encryption-keys`). Stamped at provision from the root `pithy.config.ts`
   * `name`. It is here because the account's Secrets Store is flat: the entry name is the only thing
   * separating this project's key from another project's in the same account, and the rotation has to
   * reproduce that name inside the Worker to write the new key set back where the binding reads it.
   */
  PROJECT: string;
  /** Rotation cadence in days; defaults to 30. Sourced from the `rotationIntervalDays` config option. */
  ROTATION_INTERVAL_DAYS?: string;
  /**
   * The value-rotation Workflow binding (#602), started by the cron once per due secret per day, under a
   * deterministic id so a redelivered tick starts nothing twice. Absent on a feature's manager, which runs no
   * cron. A manager with a schedule and no binding refuses the tick rather than rotating nothing in silence.
   */
  VALUE_ROTATION?: { create(options?: { id?: string; params?: ValueRotationPayload }): Promise<unknown> };
}

/**
 * The management write Workflow — the CLI dispatches create/update/remove here.
 *
 * The step runs under {@link secretsWorkflowRetry}, so a refusal the store has already decided
 * (`create` over a name that exists, `update` of a name that does not) fails the instance on its first
 * attempt instead of backing off into the same answer. See `retryPolicy.ts` for the whole classification.
 */
export class SecretsWriteWorkflow extends WorkflowEntrypoint<SecretsManagerEnv, WriteWorkflowPayload> {
  override async run(event: WorkflowEvent<WriteWorkflowPayload>, step: WorkflowStep): Promise<WriteWorkflowResult> {
    const steps = classifiedSteps(step, secretsWorkflowRetry, NonRetryableError);
    return await steps.do("write-secret", () => runWriteWorkflow(this.env, event.payload));
  }
}

/**
 * Whether a `create` was refused because an instance of that id already exists — the deterministic-id guard
 * working, rather than a fault. Matched on the message, because the platform surfaces it as a plain refusal
 * and an `instanceof` across two copies of the runtime types answers false.
 */
function isDuplicateInstance(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|duplicate/i.test(message);
}

/** The at-rest key-rotation Workflow — re-encrypts the store under a fresh master key. */
export class AtRestKeyRotationWorkflow extends WorkflowEntrypoint<SecretsManagerEnv, unknown> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    // Build the manager's secret accessor once; read the CF API token at the point of need. Every
    // place a secret is consumed is a visible `secrets.get(...)` call site (grep-able), never hidden
    // behind a wrapper.
    const secrets = await sharedSecretsStore(this.env, managerRegistry);
    const manager = new CloudflareSecretsStoreManager({
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: secrets.get(RUNTIME_TOKEN_SECRET),
      storeId: this.env.SECRETS_STORE_ID,
    });
    // The writer targets the project- and env-scoped master-key entry this worker actually binds
    // (see rotationConfigWriter), so the rotation persists exactly where it is read — and never into
    // another project's key entry in the same account-wide Secrets Store.
    //
    // Its steps run under the same classification the write does: the CF API being unreachable is worth
    // another attempt, and ciphertext that will not decrypt under the bound key set is not.
    await runRotationWorkflow(
      this.env,
      rotationConfigWriter(manager, this.env.PROJECT, this.env.ENVIRONMENT),
      classifiedSteps(step, secretsWorkflowRetry, NonRetryableError),
      undefined,
      // The pass's own identity, from the platform rather than recomposed. `RotationTracker.claimRotation`
      // hands an open row back to the holder that opened it, and that reclaim is only sound if a holder
      // string names exactly one pass — see `AtRestRotationOptions.rotatedBy`.
      event.instanceId,
    );
  }
}

/**
 * The value-rotation Workflow — one secret's value replaced on its declared period (#602).
 *
 * The rotate step runs through `classified.once`, with no retries: a `provider` roll is a call into
 * somebody else's system, and a platform re-running the step after an eviction would roll twice. Every
 * other step runs under {@link secretsWorkflowRetry}, like the write and the at-rest rotation. See
 * `rotation/valueRotation.ts`.
 *
 * A store-backed secret is written over REST with the application's one runtime token (#728), edit-only:
 * `updateExistingSecret` refuses a name with no entry rather than creating one nothing binds.
 */
export class SecretValueRotationWorkflow extends WorkflowEntrypoint<SecretsManagerEnv, ValueRotationPayload> {
  override async run(event: WorkflowEvent<ValueRotationPayload>, step: WorkflowStep): Promise<void> {
    const classified = classifiedSteps(step, secretsWorkflowRetry, NonRetryableError);
    const log = createWorkerLogger({ name: "secrets:value-rotation", fields: { instanceId: event.instanceId } });
    await runValueRotationWorkflow(
      this.env,
      event.payload,
      {
        do: (name, fn, options) => (options?.retries === false ? classified.once(name, fn) : classified.do(name, fn)),
        sleep: (name, ms) => classified.sleep(name, ms),
      },
      {
        writeEntry: async (entry, text) => {
          const secrets = await sharedSecretsStore(this.env, managerRegistry);
          const manager = new CloudflareSecretsStoreManager({
            accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
            apiToken: secrets.get(RUNTIME_TOKEN_SECRET),
            storeId: this.env.SECRETS_STORE_ID,
          });
          await manager.updateExistingSecret(entry, text);
        },
        emit: logAuditEmit(log),
        instanceId: event.instanceId,
      },
    );
  }
}

/**
 * The field-key rotation Workflow (#390) — `PITHY_FIELD_KEYS` rotated on its own period, the rows still under a
 * version leaving the window re-sealed, and that version retired on a clean guard. Also what
 * `pithy secrets retire-version` dispatches to, for the guard read and the retirement past it.
 *
 * Every step runs under {@link secretsWorkflowRetry}. The command is parsed, because it crosses the Workflows REST
 * API from the CLI, and a `retire` is the most destructive thing this Worker does.
 */
export class FieldKeyRotationWorkflow extends WorkflowEntrypoint<SecretsManagerEnv, FieldKeyCommand> {
  override async run(event: WorkflowEvent<FieldKeyCommand>, step: WorkflowStep): Promise<FieldKeyReport> {
    const command = FieldKeyCommand.parse(event.payload);
    const log = createWorkerLogger({ name: "secrets:field-keys", fields: { instanceId: event.instanceId } });
    const writer = async () => {
      const secrets = await sharedSecretsStore(this.env, managerRegistry);
      const manager = new CloudflareSecretsStoreManager({
        accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: secrets.get(RUNTIME_TOKEN_SECRET),
        storeId: this.env.SECRETS_STORE_ID,
      });
      return fieldKeysConfigWriter(manager, this.env.PROJECT, this.env.ENVIRONMENT);
    };
    return await runFieldKeyWorkflow(
      this.env,
      writer,
      classifiedSteps(step, secretsWorkflowRetry, NonRetryableError),
      command,
      { instanceId: event.instanceId, emit: logAuditEmit(log) },
    );
  }
}

/**
 * Start one value rotation through the binding, treating an id that already exists as already started.
 *
 * A manager with a schedule and no binding is refused rather than skipped: it was deployed from a template
 * that predates the Workflow, and a cron that quietly rotates nothing is the lapse this exists to end.
 */
async function startValueRotation(env: SecretsManagerEnv, id: string, payload: ValueRotationPayload): Promise<void> {
  if (env.VALUE_ROTATION === undefined) {
    throw new InternalError({
      message: "The secrets manager has a rotation schedule and no value-rotation Workflow to run it.",
      action: remedy("secrets provision").say((command) => `Redeploy the manager with ${command}.`),
      detail: `value rotation ${id}: the VALUE_ROTATION binding is absent on this manager`,
    });
  }
  try {
    await env.VALUE_ROTATION.create({ id, params: payload });
  } catch (error) {
    if (!isDuplicateInstance(error)) throw error;
  }
}

/** The at-rest half of the cron: trigger the master-key rotation only when its interval has elapsed. */
async function scheduleAtRestRotation(env: SecretsManagerEnv): Promise<void> {
  const config = await resolveEncryptionConfig(env);
  // **A structurally failed pass has a cadence consequence (#647).** A pass that could not confirm its
  // write through the binding leaves `lastRotatedAt` untouched — right for the store, since nothing
  // rotated — so without this the same pass starts again every night, mints a fresh key, and edits the
  // same entry the binding does not read, forever. The ledger is what remembers; `rotationBackedOff`
  // is what decides.
  const tracker = RotationTracker.fromD1(env.SECRETS);
  const now = new Date();
  if (rotationBackedOff(await tracker.lastClosed(AT_REST_ROTATION_NAME), now)) return;
  // The coercion sits inside the call that checks it, rather than in a `const` above. `isRotationDue`
  // refuses a non-finite or non-positive interval — a `"30 days"` that would otherwise make rotation
  // never come due, silently, on every tick — and keeping the two in one expression is what
  // `cli/src/ci/environmentNumbers.test.ts` reads to prove no raw `Number(env.…)` reaches a
  // comparison unchecked (#521).
  if (isRotationDue(config.lastRotatedAt, Number(env.ROTATION_INTERVAL_DAYS ?? DEFAULT_ROTATION_INTERVAL_DAYS), now)) {
    // A deterministic id, so two triggers over one pointer on one day are one pass. See
    // `atRestInstanceId` for what two concurrent passes do to a store.
    //
    // **The refusal it produces is the success case, so it is swallowed (#647 review).** Cron delivery is
    // at-least-once, and a redelivered tick inside one UTC day over one pointer composes the same id;
    // Cloudflare then rejects the `create`, which would fail the whole `scheduled()` invocation over a
    // guard doing precisely its job. The pass that already exists is the one we wanted. Only this
    // rejection is swallowed — anything else still leaves the handler, because a manager that cannot
    // start a rotation at all is a fact somebody needs.
    try {
      await env.AT_REST_ROTATION.create({ id: atRestInstanceId(config.currentVersion, now) });
    } catch (error) {
      if (!isDuplicateInstance(error)) throw error;
    }
  }
}

export default {
  /**
   * Cron entry: the at-rest rotation when its interval has elapsed, then every due value rotation.
   *
   * **The two halves are independent, and neither may stop the other.** The at-rest half returns early on a
   * backoff and throws on a master key that will not resolve; a value rotation that waited behind either
   * would lapse for a reason that has nothing to do with it. Both run, and the first failure is rethrown
   * after both, so the invocation is still recorded as failed.
   */
  async scheduled(_controller: unknown, env: SecretsManagerEnv): Promise<void> {
    // A feature's manager has no cron and no rotation Workflow (#643). Should a trigger reach one anyway, it
    // rotates nothing: it holds no token to write the new key back with.
    if (env.ENVIRONMENT === FEATURE_ENVIRONMENT) return;
    const failures: unknown[] = [];
    try {
      await scheduleAtRestRotation(env);
    } catch (error) {
      failures.push(error);
    }
    try {
      // The field key's own period, beside the master key's (#390). Independent of both other halves.
      await scheduleFieldKeyRotation(env, new Date(), async (id, command) => {
        if (env.FIELD_KEY_ROTATION === undefined) {
          throw new InternalError({
            message: "The secrets manager binds a field key and no Workflow to rotate it.",
            action: remedy("secrets provision").say((command) => `Redeploy the manager with ${command}.`),
            detail: `field-key rotation ${id}: the FIELD_KEY_ROTATION binding is absent on this manager`,
          });
        }
        try {
          await env.FIELD_KEY_ROTATION.create({ id, params: command });
        } catch (error) {
          if (!isDuplicateInstance(error)) throw error;
        }
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await scheduleValueRotations(env, {
        now: new Date(),
        start: (id, payload) => startValueRotation(env, id, payload),
        log: createWorkerLogger({ name: "secrets:value-rotation" }),
      });
    } catch (error) {
      failures.push(error);
    }
    if (failures[0] !== undefined) throw failures[0];
  },
};
