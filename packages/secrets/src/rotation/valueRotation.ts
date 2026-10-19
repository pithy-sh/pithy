// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { SecretsAuditActions } from "../audit/actions";
import type { SecretRegistryEntry } from "../registry";
import type { ManagedEnvironment } from "../scope";
import { type RotationSleeper, rotateSecretValue, type SecretRotationOutcome } from "./rotateValue";
import { type RotationLedger, rotationClosure } from "./rotationLedger";
import type { AppendedVersion, VersionedSecretStore } from "./versionStore";

/**
 * **One unattended rotation of one secret's value: rotate, wait out the overlap, retire (#602).**
 *
 * The secrets manager's cron starts one of these when a secret's `rotateEveryDays` has elapsed. It is a
 * Workflow because the act spans days: the new version is live at once, the previous one keeps verifying
 * for the entry's declared overlap, and only then is it removed. A timer cannot hold a week; a durable
 * sleep can.
 *
 * ## The rotation is `rotateSecretValue`, in one step that is never retried
 *
 * The same function `pithy secrets rotate` and the control-plane route call, so the ordering is the one
 * stated there — refuse, open the ledger row, produce the value once, store it with retries against that
 * value, close the row. It runs inside **one** step declared `retries: false`, because a `provider` roll
 * mutates somebody else's system: a platform that re-ran the step after an eviction would roll a third
 * credential and lose the second, which is the failure `valueRotator.ts` exists to prevent.
 *
 * The store is retried, inside that step, by `rotateSecretValue` itself. **The successor never leaves the
 * step**: what the step returns is journalled by the platform, readable in the instance's history, so it
 * returns the outcome and the version key the successor landed under — never the value. Splitting the
 * roll and the store into two steps would have meant journalling the value between them.
 *
 * ## Retirement never strands a value sealed under the old version
 *
 * Waiting out the overlap makes the old version safe to retire for everything that expires. It does not
 * for what is encrypted under it at rest — the JWKS private keys under the session secret — so the entry
 * names those (`overlap.reencrypt`), their owner records when it has moved them, and retirement waits for
 * every one. It checks once a day for {@link REENCRYPTION_CHECKS} days, and then **holds**: the old version
 * stays, the ledger records a failed row under `not-retired`, and the audit trail says which dependent is
 * behind. A version kept too long costs an envelope one entry larger. A version retired too soon costs
 * every value sealed under it.
 *
 * ## What it records
 *
 * The ledger row is `rotateSecretValue`'s, opened before the roll and closed after the store, with trigger
 * `cron` — so the status read's `lastRotatedAt` moves and the secret stops reporting overdue. A held
 * retirement is a second, failed row: the rotation happened, the cleanup did not, and an owner should hear
 * about the second without the first being reported as having failed. Both are audited as `system` acts.
 */

/** How long one day is, in the unit a Workflow sleep takes. */
const DAY_MS = 86_400_000;

/** How many daily checks retirement makes for a dependent to re-encrypt before it holds the old version. */
export const REENCRYPTION_CHECKS = 7;

/** The wait between two of those checks. */
export const REENCRYPTION_WAIT_MS = DAY_MS;

/** The half of a Workflow step runner this needs: a step that may declare it must never be retried, and a durable sleep. */
export interface ValueRotationSteps {
  /** Run a named step, or serve its journalled result. `retries: false` means the platform must never re-run it. */
  do<T>(name: string, fn: () => Promise<T>, options?: { retries: false }): Promise<T>;
  /** Pause the instance, durably, and resume afterwards. */
  sleep(name: string, durationMs: number): Promise<void>;
}

/** Everything one run needs, injected so the body runs the same in a test, in Miniflare and in the manager. */
export interface ValueRotationDeps {
  /** The secret, by registry name. */
  name: string;
  /** Its registry entry — one `unattendedRotation` answers `rotates` for, overlap included. */
  entry: SecretRegistryEntry;
  /** The environment this manager is. The one environment the value is written to. */
  environment: ManagedEnvironment;
  /** Where the version is appended and, later, the previous one retired. */
  store: VersionedSecretStore;
  /** The rotation ledger, opened before the roll and closed after the store. Its trigger is `cron`. */
  ledger: RotationLedger;
  /** Record a retirement that held the old version — a failed `not-retired` row under the secret's name. */
  holdRetirement(name: string): Promise<void>;
  /** The dependents of this secret not yet re-encrypted under `version`. See `./reencryption.ts`. */
  pending(dependents: readonly string[], version: string): Promise<string[]>;
  /** The audit seam. The manager composes no recorder, so it logs; see `manager/auditLog.ts`. */
  emit: AuditEmit;
  /** Who is rotating — the Workflow instance id, so a row and an event name the run they came from. */
  rotatedBy: string;
  /** Store attempts inside the rotate step. Defaults to `rotateSecretValue`'s own. Never a re-roll. */
  attempts?: number;
  /** Backoff between those attempts. Injected in tests. */
  sleep?: RotationSleeper;
}

/** What one run did, in version keys. Never a value. */
export interface ValueRotationResult {
  /** How the rotation ended — `rotateSecretValue`'s own status. */
  status: SecretRotationOutcome["status"];
  /** The version the successor is current under, when one was stored. */
  version?: string;
  /** The versions retired after the overlap. Empty when nothing was, or nothing needed to be. */
  retired: string[];
  /** Dependents still sealed under a previous version when retirement gave up. Empty unless it held. */
  held: string[];
}

/** What the rotate step journals: the outcome's facts, and the version keys. No value, and no `cause`. */
interface JournalledRotation {
  status: SecretRotationOutcome["status"];
  kind: SecretRotationOutcome["kind"];
  rolled: boolean;
  rollFailed?: boolean;
  recorded: ManagedEnvironment[];
  stranded: ManagedEnvironment[];
  attempts?: number;
  appended?: AppendedVersion;
}

/**
 * The outcome, with `cause` dropped. A cause is an exception, and an exception from a store write is the
 * one place in this module a value could have been interpolated — so it stays in this process and is
 * never journalled, logged or audited. The closure's code says what an operator needs.
 */
function journalled(outcome: SecretRotationOutcome, appended: AppendedVersion | undefined): JournalledRotation {
  return {
    status: outcome.status,
    kind: outcome.kind,
    rolled: outcome.rolled,
    ...(outcome.rollFailed === undefined ? {} : { rollFailed: outcome.rollFailed }),
    recorded: outcome.recorded,
    stranded: outcome.stranded,
    ...(outcome.attempts === undefined ? {} : { attempts: outcome.attempts }),
    ...(appended === undefined ? {} : { appended }),
  };
}

/** The audit event for the rotation itself, on both outcomes. `critical` for the one that needs a human now. */
async function auditRotation(deps: ValueRotationDeps, rotation: JournalledRotation): Promise<void> {
  const closure = rotationClosure({ name: deps.name, ...rotation }, deps.environment);
  await deps.emit({
    action: SecretsAuditActions.rotated,
    outcome: rotation.status === "rotated" ? "success" : "failure",
    severity: rotation.status === "rotated" ? "info" : rotation.status === "unrecorded" ? "critical" : "warning",
    actorType: "system",
    actorId: null,
    resourceType: "secret",
    resourceId: deps.name,
    metadata: {
      name: deps.name,
      trigger: "cron",
      workflowInstance: deps.rotatedBy,
      status: rotation.status,
      rotation: rotation.kind,
      rolled: rotation.rolled,
      environments: rotation.recorded,
      ...(rotation.appended === undefined ? {} : { version: rotation.appended.version }),
      ...(closure.status === "failed" ? { reason: closure.reason } : {}),
      ...(rotation.rollFailed === undefined ? {} : { rollFailed: rotation.rollFailed }),
      ...(rotation.stranded.length > 0 ? { stranded: rotation.stranded } : {}),
    },
  });
}

/** The audit event for the retirement: which versions went, or which dependents held them. */
async function auditRetirement(
  deps: ValueRotationDeps,
  retirement: { version: string; retired: string[]; pending: string[] },
): Promise<void> {
  const held = retirement.pending.length > 0;
  await deps.emit({
    action: SecretsAuditActions.versionRetired,
    outcome: held ? "failure" : "success",
    severity: held ? "warning" : "info",
    actorType: "system",
    actorId: null,
    resourceType: "secret",
    resourceId: deps.name,
    metadata: {
      name: deps.name,
      trigger: "cron",
      workflowInstance: deps.rotatedBy,
      version: retirement.version,
      retired: retirement.retired,
      ...(held ? { pending: retirement.pending, reason: "not-retired" } : {}),
    },
  });
}

/**
 * Rotate one secret, wait out its overlap, and retire the version it replaced.
 *
 * Throws only for a declaration it cannot act on — before anything is called, so nothing is left half
 * done. Everything that happens after the roll is reported in the result, the ledger and the trail.
 */
export async function runValueRotation(
  deps: ValueRotationDeps,
  steps: ValueRotationSteps,
): Promise<ValueRotationResult> {
  const { name, entry } = deps;
  const overlap = entry.overlap;
  if (overlap === undefined) {
    throw new InternalError({
      message: `Secret '${name}' declares no overlap, so the cron will not rotate it.`,
      action: "Add overlap: { days, minimumDays } to its registry entry.",
      detail: `value rotation of '${name}' started with no overlap on the entry`,
    });
  }

  const rotation = await steps.do(
    "rotate",
    async () => {
      let appended: AppendedVersion | undefined;
      const outcome = await rotateSecretValue({
        name,
        entry,
        targets: [deps.environment],
        ledger: deps.ledger,
        store: async ({ value }) => {
          appended = await deps.store.append(name, value);
        },
        ...(deps.attempts === undefined ? {} : { attempts: deps.attempts }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      });
      return journalled(outcome, appended);
    },
    { retries: false },
  );
  await steps.do("audit-rotation", () => auditRotation(deps, rotation));

  const appended = rotation.appended;
  if (rotation.status !== "rotated" || appended === undefined) {
    return { status: rotation.status, retired: [], held: [] };
  }
  if (appended.prior.length === 0) return { status: "rotated", version: appended.version, retired: [], held: [] };

  await steps.sleep("overlap", overlap.days * DAY_MS);

  const dependents = overlap.reencrypt ?? [];
  let pending = await steps.do("reencrypted-0", () => deps.pending(dependents, appended.version));
  for (let check = 1; pending.length > 0 && check < REENCRYPTION_CHECKS; check++) {
    await steps.sleep(`reencrypt-wait-${check}`, REENCRYPTION_WAIT_MS);
    pending = await steps.do(`reencrypted-${check}`, () => deps.pending(dependents, appended.version));
  }
  if (pending.length > 0) {
    const waiting = pending;
    await steps.do("hold-retirement", () => deps.holdRetirement(name));
    await steps.do("audit-retirement", () =>
      auditRetirement(deps, { version: appended.version, retired: [], pending: waiting }),
    );
    return { status: "rotated", version: appended.version, retired: [], held: waiting };
  }

  const left = await steps.do("retire", () => deps.store.retire(name, appended.prior));
  const retired = appended.prior.filter((version) => !left.versions.includes(version));
  await steps.do("audit-retirement", () => auditRetirement(deps, { version: appended.version, retired, pending: [] }));
  return { status: "rotated", version: appended.version, retired, held: [] };
}
