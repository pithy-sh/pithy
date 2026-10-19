// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { z } from "zod";
import { secretsTables } from "../data/tables";
import { secretBindingName } from "../env/bindingName";
import { resolveBinding, type SecretBinding, type SecretsStoreEnv } from "../env/bindings";
import { type SecretRegistryEntry, validateSecretEntry } from "../registry";
import { pendingReencryptions } from "../rotation/reencryption";
import {
  parseStampedRotations,
  planValueRotations,
  rotationStoreEntry,
  StampedRotation,
  stampedEntry,
  type ValueRotationDecision,
  valueRotationInstanceId,
} from "../rotation/rotationSchedule";
import { runValueRotation, type ValueRotationResult, type ValueRotationSteps } from "../rotation/valueRotation";
import { d1VersionStore, secretsStoreVersionStore, type VersionedSecretStore } from "../rotation/versionStore";
import { ManagedEnvironment } from "../scope";
import { RotationTracker, trackerRotationLedger } from "../store/rotationTracker";
import { SystemSecretsStore } from "../store/systemSecretsStore";

/**
 * **The secrets manager's half of unattended value rotation: the cron's plan, and the Workflow body it
 * starts (#602).** No `cloudflare:` import, so Miniflare runs every line of it; `worker.ts` is the thin
 * durable shell that wires the platform's step runner and the Secrets Store REST client in.
 *
 * The manager rotates what it can reach, and it reaches both backends:
 *
 * - **`d1`** — this environment's vault, through the `SECRETS` binding and the master key the manager
 *   already holds. The same store the write Workflow seals values into.
 * - **`cf-secrets-store`** — read through a binding provisioning gives the manager for exactly the secrets
 *   it rotates (`secretBindingName(name)`), and written over REST with the application's one runtime token
 *   (#728), the same token and the same permission the at-rest rotation's write-back already uses. No
 *   second token is minted for this, and none may be.
 *
 * Either way the value is minted inside the manager and written inside it, so no other process ever holds
 * it — not the CLI, not a management client, not the Workflow's own journal.
 */

/** What the manager's env adds for value rotation. Every field is stamped at provision. */
export interface ValueRotationEnv extends SecretsStoreEnv {
  /** This manager's environment. Parsed where it is read: a var is external config. */
  ENVIRONMENT: ManagedEnvironment;
  /** This manager's project — half of every Secrets Store entry name. */
  PROJECT: string;
  /** The rotation schedule, as JSON — see `rotation/rotationSchedule.ts`. Absent is no schedule. */
  VALUE_ROTATIONS?: string;
  /** The environment whose manager owns global secrets: the last declared. Absent owns none. */
  GLOBAL_ENVIRONMENT?: string;
}

/** The value-rotation Workflow's payload: one stamped declaration, nothing else. */
export const ValueRotationPayload = z
  .object({ rotation: StampedRotation.describe("The secret to rotate, as the schedule declares it.") })
  .describe("One unattended value rotation, as the cron starts it. Carries a declaration, never a value.");
export type ValueRotationPayload = z.output<typeof ValueRotationPayload>;

/** Write one Secrets Store entry's plaintext, by entry name. The manager passes an edit-only REST writer. */
export type StoreEntryWriter = (entry: string, text: string) => Promise<void>;

/** The version store for one stamped secret, on whichever backend it declares. */
export async function valueRotationStore(
  env: ValueRotationEnv,
  rotation: StampedRotation,
  writeEntry: StoreEntryWriter,
): Promise<VersionedSecretStore> {
  if (rotation.backend === "d1") return d1VersionStore(await SystemSecretsStore.fromEnv(env), rotation.valueType);
  const binding = secretBindingName(rotation.name);
  const entry = rotationStoreEntry(env.PROJECT, env.ENVIRONMENT, rotation);
  return secretsStoreVersionStore({
    read: async (name) => {
      const bound = (env as unknown as Record<string, SecretBinding | string | undefined>)[binding];
      if (bound === undefined) return undefined;
      return await resolveBinding(bound, binding, name);
    },
    write: (_name, text) => writeEntry(entry, text),
  });
}

/** What the Workflow body needs from its host beyond the env. */
export interface ValueRotationHost {
  /** The REST writer for a store-backed secret. Never called for `d1`. */
  writeEntry: StoreEntryWriter;
  /** The audit seam. */
  emit: AuditEmit;
  /** The Workflow instance id — who the ledger rows and audit events name. */
  instanceId: string;
}

/**
 * The value-rotation Workflow's body. Parses its payload, rebuilds the entry and has the registry check it
 * again, refuses a global secret this manager does not own, then hands off to `runValueRotation`.
 */
export async function runValueRotationWorkflow(
  env: ValueRotationEnv,
  payload: unknown,
  steps: ValueRotationSteps,
  host: ValueRotationHost,
): Promise<ValueRotationResult> {
  const parsed = ValueRotationPayload.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError({
      message: "This value rotation was started with a payload the secrets manager cannot read.",
      detail: "value rotation payload did not parse as a stamped rotation",
    });
  }
  const { rotation } = parsed.data;
  const environment = ManagedEnvironment.parse(env.ENVIRONMENT);
  // By construction, whatever started this instance: one manager owns a global secret, and it is not this one.
  if (rotation.scope === "global" && env.GLOBAL_ENVIRONMENT !== environment) {
    throw new InternalError({
      message: `Secret '${rotation.name}' is global, and the ${environment} manager does not rotate global secrets.`,
      detail: `value rotation of global '${rotation.name}' reached ${environment}; GLOBAL_ENVIRONMENT is ${env.GLOBAL_ENVIRONMENT ?? "unset"}`,
    });
  }
  // The stamp is external config, so the registry's refusals run over it again before anything acts on it.
  const entry: SecretRegistryEntry = stampedEntry(rotation);
  validateSecretEntry(rotation.name, entry);
  const tracker = RotationTracker.fromD1(env.SECRETS);
  const db = createDatabase(env.SECRETS, secretsTables);
  const store = await valueRotationStore(env, rotation, host.writeEntry);
  return await runValueRotation(
    {
      name: rotation.name,
      entry,
      environment,
      store,
      ledger: trackerRotationLedger(tracker, { environment, trigger: "cron", rotatedBy: host.instanceId }),
      holdRetirement: async (name) => {
        const id = await tracker.startRotation(name, "cron", host.instanceId);
        await tracker.markFailure(id, "not-retired");
      },
      // Checked against the envelope as it stands at the check, so a record from before an `update` reset the
      // version numbers names nothing (#602).
      pending: async (dependents, version) =>
        await pendingReencryptions(
          db,
          rotation.name,
          dependents,
          version,
          (await store.fingerprints(rotation.name)) ?? {},
        ),
      emit: host.emit,
      rotatedBy: host.instanceId,
    },
    steps,
  );
}

/** Start one rotation instance. The manager's binding create, with a duplicate id meaning *already started*. */
export type StartValueRotation = (id: string, payload: ValueRotationPayload) => Promise<void>;

/** What one tick of the cron needs from its host. */
export interface ValueRotationTick {
  /** The tick's clock. */
  now: Date;
  /** Start a rotation instance. */
  start: StartValueRotation;
  /** Where the tick says what it decided. */
  log: Logger;
}

/**
 * One cron tick's value rotations: read the schedule, plan every secret against this environment's ledger,
 * and act on the plan — start what is due, baseline what the schedule has never seen, report what nothing
 * here can rotate. Returns the plan, so a test asserts on decisions rather than on side effects alone.
 *
 * Each `start` is independent: one that fails to start does not stop the next. The first failure is
 * rethrown once every secret has been considered, so the invocation is still recorded as failed.
 */
export async function scheduleValueRotations(
  env: ValueRotationEnv,
  tick: ValueRotationTick,
): Promise<ValueRotationDecision[]> {
  const stamped = parseStampedRotations(env.VALUE_ROTATIONS);
  if (stamped.length === 0) return [];
  const tracker = RotationTracker.fromD1(env.SECRETS);
  const last = new Map<string, Date | null>();
  const since = new Map<string, Date | null>();
  for (const one of stamped) {
    last.set(one.name, await tracker.getLatestSuccess(one.name));
    since.set(one.name, await tracker.getScheduleClock(one.name));
  }
  const plan = planValueRotations({
    stamped,
    environment: env.ENVIRONMENT,
    ...(env.GLOBAL_ENVIRONMENT === undefined ? {} : { globalEnvironment: env.GLOBAL_ENVIRONMENT }),
    lastSuccess: (name) => last.get(name) ?? null,
    scheduledSince: (name) => since.get(name) ?? null,
    now: tick.now,
  });
  const failures: unknown[] = [];
  for (const decision of plan) {
    const rotation = stamped.find((one) => one.name === decision.name) as StampedRotation;
    try {
      if (decision.decision === "start") {
        await tick.start(valueRotationInstanceId(decision.name, tick.now), { rotation });
        tick.log.info("value rotation started", { name: decision.name });
      } else if (decision.decision === "baseline") {
        await tracker.recordScheduleBaseline(decision.name);
        tick.log.info("value rotation baseline recorded", { name: decision.name });
      } else if (decision.decision === "report" && decision.overdue === true) {
        tick.log.warn("secret overdue, and nothing here can rotate it", {
          name: decision.name,
          reason: decision.reason,
        });
      } else if (decision.decision === "refused") {
        tick.log.error("value rotation refused", { name: decision.name, reason: decision.reason });
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures[0] !== undefined) throw failures[0];
  return plan;
}
