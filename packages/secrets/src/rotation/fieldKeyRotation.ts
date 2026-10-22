// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { remedy } from "@pithy-sh/core/src/cli/command";
import type { EncryptionConfig } from "@pithy-sh/core/src/crypto/envelope";
import { FIELD_KEYS_BINDING, liveVersions } from "@pithy-sh/core/src/crypto/fieldKeys";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { EncryptedColumn, EncryptedColumnStamp } from "@pithy-sh/core/src/privacy/encryptedColumns";
import { countStale, resealBatch } from "@pithy-sh/core/src/privacy/fieldRotation";
import { RetirementVerdict, retirementVerdict, versionsDue } from "@pithy-sh/core/src/privacy/retirement";
import { z } from "zod";
import { SecretsAuditActions } from "../audit/actions";
import { FIELD_KEY_ROTATION_NAME } from "../data/secretRotations";
import { SecretCryptoError } from "../error/errors";
import type { ConfigReader } from "../manager/configReader";
import type { RotationPass } from "../manager/configStamp";
import type { ConfigWriter } from "../manager/configWriter";
import type { RotationTracker } from "../store/rotationTracker";
import type { StepRunner } from "./atRestKeyRotation";
import { generateKeyB64, highestVersion } from "./keyRotation";
import type { RotationFailureCode } from "./rotationLedger";

/**
 * **The field key's rotation: lazy, with a rotator that clears what is left** (#390).
 *
 * `PITHY_FIELD_KEYS` rotates on a 30-day period, by the manager's existing nightly cron, in this order:
 *
 * 1. **Add a version, which becomes current.** Staged first and confirmed through the manager's own binding, then
 *    promoted and confirmed again, the order `#647` set for the master key: by the time the pointer moves, the key
 *    it names is readable, so a row an app Worker seals under it can be opened.
 * 2. **Re-seal the rows still under the version leaving the window, and only those**, re-indexing each in the same
 *    write. Found by `json_extract`, each a compare-and-swap, in batches — across nights if a table needs it, which
 *    is what the cron's `backfill` pass is.
 * 3. **Retire it once the guard reads clean** — a zero stale count across every stamped envelope and index column,
 *    complete coverage, and no unrotatable field. On anything else nothing is retired and rotation goes on.
 *
 * The normal state is two live versions, current and previous: every write seals under current, so a row moves off
 * an old key the next time it is written. A version still live when the next rotation is due is a **failure, not a
 * backlog**: an audit event names what blocked it, and the pass closes `field-key-overdue`, which `pithy doctor`
 * reports as an error. No version is added while {@link MAX_LIVE_FIELD_KEY_VERSIONS} are live, rather than drift
 * toward the Secrets Store's 64 KiB ceiling: that pass still re-seals and retires on a clean guard, and otherwise is
 * refused, naming the blocker.
 *
 * `SECRETS_ENCRYPTION_KEYS`, and the way secrets' own rows rotate, are untouched: this is a separate key in the same
 * format, rotated by the same cron, through its own Workflow.
 */

/** The live-version count at which a rotation is refused rather than adding a fifth. */
export const MAX_LIVE_FIELD_KEY_VERSIONS = 4;

/** What one field-key Workflow instance is asked to do. */
export const FieldKeyCommand = z
  .discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("rotate").describe("Add a version, re-seal what is leaving, retire it on a clean guard."),
      })
      .describe("The 30-day rotation."),
    z
      .object({ mode: z.literal("backfill").describe("Re-seal what is leaving, and retire it on a clean guard.") })
      .describe("The nightly continuation of a rotation whose backfill did not finish."),
    z
      .object({ mode: z.literal("guard").describe("Read the guard and the stale counts. Writes nothing.") })
      .describe("What `pithy secrets retire-version` shows before it asks."),
    z
      .object({
        mode: z
          .literal("retire")
          .describe("Retire one version past a dirty guard, on an operator's typed confirmation."),
        version: z.number().int().nonnegative().describe("The version to retire. Never the current one."),
        pastGuard: z.literal(true).describe("The operator saw what the guard could not, and typed the version back."),
      })
      .describe("`pithy secrets retire-version --past-guard`, dispatched."),
  ])
  .describe("One field-key rotation Workflow command.");
export type FieldKeyCommand = z.output<typeof FieldKeyCommand>;

/** One stamped column's stale count, as the guard and the operator read it. */
export const ColumnStaleCount = z
  .object({
    table: z.string().describe("The SQL table."),
    column: z.string().describe("The SQL column."),
    path: z.string().describe("The field path the AAD binds."),
    stale: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "Rows still under a version due to leave, envelopes and indexes together. Null where it could not be read.",
      ),
  })
  .describe("How many rows of one encrypted column are still under a version due to leave.");
export type ColumnStaleCount = z.output<typeof ColumnStaleCount>;

/** What one field-key instance reports: counts, versions and names, never a key. */
export const FieldKeyReport = z
  .object({
    outcome: z.enum(["rotated", "backfilled", "guard", "retired", "refused"]).describe("What the instance did."),
    liveVersions: z.array(z.number().int()).describe("Every live version after the instance, newest first."),
    retired: z.array(z.number().int()).describe("The versions this instance retired."),
    verdict: RetirementVerdict.describe("The retirement guard, read last."),
    columns: z.array(ColumnStaleCount).describe("Every stamped column's stale count."),
    unrotatable: z.array(z.string()).describe("Every encrypted field resting outside D1."),
    unread: z.array(z.string()).describe("Every schema source the stamp could not read."),
  })
  .describe("One field-key rotation instance's output.");
export type FieldKeyReport = z.output<typeof FieldKeyReport>;

/** Everything a field-key pass needs, injected so the core is testable without Cloudflare wiring. */
export interface FieldKeyRotationDeps {
  /**
   * The field key the instance was started over, resolved from the manager's `PITHY_FIELD_KEYS` binding. Re-resolved
   * on every resume, so nothing decides from it: a pass reads the key set through {@link reader} in a step.
   */
  config: EncryptionConfig;
  /** The encrypted columns the manager was stamped with. */
  stamp: EncryptedColumnStamp;
  /** The D1 a stamped binding names, or `undefined` where the manager was not bound to it. */
  database: (binding: string) => D1Database | undefined;
  /** Writes the field key back to its Secrets Store entry, edit-only. Never called by a guard read. */
  writer: Pick<ConfigWriter, "write">;
  /** Reads it back through the binding, the only end that can confirm content. */
  reader: ConfigReader;
  /** The rotation ledger. */
  tracker: RotationTracker;
  /** Where audit events go. */
  emit: AuditEmit;
}

/** Tuning, and the pass's identity. */
export interface FieldKeyRotationOptions {
  /** Rows per batch. Defaults to 100. */
  batchSize?: number;
  /** Batches per column per pass. Defaults to 50; what is left is the next night's. */
  maxBatches?: number;
  /** The Workflow instance id, the single-flight holder. */
  rotatedBy?: string;
  /** The clock, for a test. Read inside the `pass-instant` step. */
  now?: Date;
  /** Read-back attempts. Defaults to five. */
  readBackAttempts?: number;
  /** Milliseconds between read-back attempts. Defaults to fifteen seconds. */
  readBackDelayMs?: number;
}

/** A config with the given versions retired. Never the current one. */
function withoutVersions(config: EncryptionConfig, retire: readonly number[]): EncryptionConfig {
  const drop = new Set(retire.map(String));
  drop.delete(config.currentVersion);
  return {
    currentVersion: config.currentVersion,
    versions: Object.fromEntries(Object.entries(config.versions).filter(([version]) => !drop.has(version))),
    lastRotatedAt: config.lastRotatedAt,
  };
}

/** Whether two key sets name the same pointer and hold the same versions under the same keys. Compared, never echoed. */
function sameKeySet(left: EncryptionConfig, right: EncryptionConfig): boolean {
  if (left.currentVersion !== right.currentVersion) return false;
  const leftVersions = Object.keys(left.versions);
  if (leftVersions.length !== Object.keys(right.versions).length) return false;
  return leftVersions.every((version) => left.versions[version] === right.versions[version]);
}

/**
 * Write `next` over the key set a decision was made from, and only over that one. The entry takes a full-value
 * replace with no conditional write, so this re-reads it through the binding inside the write's own step and
 * refuses when it moved: a retirement computed from `{1,2,3}` and written after a rotation promoted 4 would delete
 * version 4 under every row sealed with it.
 */
async function writeOver(
  deps: FieldKeyRotationDeps,
  read: EncryptionConfig,
  next: EncryptionConfig,
  pass: RotationPass,
): Promise<void> {
  if (!sameKeySet(await deps.reader.read(), read)) {
    throw new ConflictError({
      message: "The field key changed after this pass read it, so nothing was written.",
      action: "Nothing to undo. Run it again: the next pass reads the key set as it is now.",
      detail: `field-key rotation: the ${FIELD_KEYS_BINDING} key set changed between this pass's read and its write`,
    });
  }
  await deps.writer.write(next, pass);
}

/**
 * Open this pass's ledger row only where none is open: the row is the single-flight lock (`#647`), held by every
 * pass that writes the key set — a rotation, a backfill's retirement, and a retirement past the guard. `null` is a
 * pass already holding it.
 */
function claimPass(
  deps: FieldKeyRotationDeps,
  trigger: "cron" | "manual",
  rotatedBy: string,
  keySetSize: number,
  reclaimAs: string | undefined,
): Promise<number | null> {
  return deps.tracker.claimRotation(FIELD_KEY_ROTATION_NAME, trigger, rotatedBy, { keySetSize }, reclaimAs);
}

/** The refusal a pass raises when another holds the ledger. */
function alreadyRunning(): ConflictError {
  return new ConflictError({
    message: "A field-key rotation is already running for this environment.",
    action: "Nothing to run. Wait for the running pass to finish; the next scheduled one starts after it.",
    detail: "field-key rotation: the ledger already holds an open pass",
  });
}

/** The audit event for a version retired on a clean guard. */
async function emitRetired(deps: FieldKeyRotationDeps, due: readonly number[]): Promise<void> {
  await deps.emit({
    action: SecretsAuditActions.fieldKeyRetired,
    outcome: "success",
    severity: "warning",
    actorType: "system",
    resourceType: "secret",
    resourceId: FIELD_KEYS_BINDING,
    metadata: { versions: due.join(","), pastGuard: false },
  });
}

/** The guard over every stamped column, with each column's count. Never throws: an unreadable count is coverage. */
async function readGuard(
  deps: FieldKeyRotationDeps,
  versions: readonly number[],
): Promise<{ verdict: RetirementVerdict; columns: ColumnStaleCount[] }> {
  const due = versionsDue(versions);
  let coverageComplete = deps.stamp.unread.length === 0;
  let stale = 0;
  const columns: ColumnStaleCount[] = [];
  for (const column of deps.stamp.columns) {
    const d1 = deps.database(column.binding);
    let count: number | null = null;
    if (d1) {
      try {
        count = await countStale(d1, column, due);
      } catch {
        count = null;
      }
    }
    if (count === null) coverageComplete = false;
    else stale += count;
    columns.push({ table: column.table, column: column.column, path: column.path, stale: count });
  }
  return {
    verdict: retirementVerdict({ versions, stale, coverageComplete, unrotatable: deps.stamp.unrotatable.length }),
    columns,
  };
}

/** Re-seal every stamped column's rows under the versions due to leave, onto the current version. */
async function backfill(
  deps: FieldKeyRotationDeps,
  step: StepRunner,
  config: EncryptionConfig,
  options: Required<Pick<FieldKeyRotationOptions, "batchSize" | "maxBatches">>,
): Promise<void> {
  const due = versionsDue(liveVersions(config));
  // An index loop rather than `entries()`: a driver body evaluates no nullary call outside a step (#331).
  for (let index = 0; index < deps.stamp.columns.length; index += 1) {
    const column = deps.stamp.columns[index] as EncryptedColumn;
    const d1 = deps.database(column.binding);
    if (!d1) continue;
    for (const version of due) {
      for (let batch = 0; batch < options.maxBatches; batch += 1) {
        const result = await step.do(`reseal-${index}-${version}-${batch}`, () =>
          resealBatch(d1, column, config, version, options.batchSize),
        );
        // No progress — the column is clear of this version, or only rows that will not open are left.
        if (result.resealed === 0 && result.skipped === 0) break;
      }
    }
  }
}

/** Poll the binding until it shows the write, aborting from inside the last read's step. */
async function confirmed(
  step: StepRunner,
  reader: ConfigReader,
  label: string,
  landed: (config: EncryptionConfig) => boolean,
  attempts: number,
  delayMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await step.sleep(`${label}-wait-${attempt}`, delayMs);
    const last = attempt === attempts - 1;
    const seen = await step.do(`${label}-${attempt}`, async () => {
      const shown = landed(await reader.read());
      if (!shown && last) {
        throw new SecretCryptoError({
          message: "The rotated field key did not come back through the binding.",
          action: `Check that the manager's ${FIELD_KEYS_BINDING} binding names the entry this rotation writes. ${remedy("secrets provision").say((command) => `Redeploy it with \`${command}\`.`)}`,
          detail: `field-key rotation: ${attempts} reads of ${FIELD_KEYS_BINDING} did not show the write (${label}); nothing was re-sealed`,
        });
      }
      return shown;
    });
    if (seen) return;
  }
}

/** The audit event for a guard that held a version due to leave. */
async function emitBlocked(
  deps: FieldKeyRotationDeps,
  verdict: RetirementVerdict,
  due: readonly number[],
  overdue: boolean,
): Promise<void> {
  await deps.emit({
    action: SecretsAuditActions.fieldKeyRetirementBlocked,
    outcome: "failure",
    severity: overdue ? "critical" : "warning",
    actorType: "system",
    resourceType: "secret",
    resourceId: FIELD_KEYS_BINDING,
    metadata: { versions: due.join(","), reasons: verdict.reasons.join(","), overdue },
  });
}

/**
 * Run one field-key command in durable steps. See the module note for the order and why it is the order.
 *
 * **Every decision reads the `key-set` step, never `deps.config`.** A Workflow body re-runs from the top on every
 * resume and the shell resolves the binding again each time, so after a read-back sleep `deps.config` already holds
 * the version this pass staged. The step journals the set the pass first read, and the start versions, the overdue
 * call, the ceiling and every retirement are computed from it. Every audit event is a step, so a resume does not
 * send it twice.
 *
 * `guard` writes nothing. `retire` retires one version an operator typed back, past whatever the guard says, and
 * refuses the current one. `backfill` re-seals and retires on a clean guard. `rotate` is the whole sequence. Every
 * write of the key set is single-flight on the ledger, and the retirements write only over the set they read.
 */
export async function runFieldKeyCommand(
  deps: FieldKeyRotationDeps,
  step: StepRunner,
  command: FieldKeyCommand,
  options: FieldKeyRotationOptions = {},
): Promise<FieldKeyReport> {
  const tuning = { batchSize: options.batchSize ?? 100, maxBatches: options.maxBatches ?? 50 };
  const attempts = options.readBackAttempts ?? 5;
  const delayMs = options.readBackDelayMs ?? 15_000;
  const nowMs: number = await step.do("pass-instant", async () => (options.now ?? new Date()).getTime());
  const now = new Date(nowMs);
  const rotatedBy = options.rotatedBy ?? "cron";
  const report = async (
    outcome: FieldKeyReport["outcome"],
    config: EncryptionConfig,
    retired: number[],
  ): Promise<FieldKeyReport> => {
    const versions = liveVersions(config);
    const guard = await step.do(`report-guard-${outcome}`, () => readGuard(deps, versions));
    return {
      outcome,
      liveVersions: versions,
      retired,
      verdict: guard.verdict,
      columns: guard.columns,
      unrotatable: [...deps.stamp.unrotatable],
      unread: [...deps.stamp.unread],
    };
  };

  if (command.mode === "guard") {
    const read = await step.do("key-set", () => deps.reader.read());
    return report("guard", read, []);
  }

  if (command.mode === "retire") {
    const read = await step.do("key-set", () => deps.reader.read());
    if (String(command.version) === read.currentVersion) {
      throw new ValidationError({
        message: `Version ${command.version} is the field key's current version, which seals every write.`,
        action: "Retire an older version. The current one is retired only after the next rotation replaces it.",
      });
    }
    if (read.versions[String(command.version)] === undefined) {
      throw new ValidationError({
        message: `Version ${command.version} is not a live field-key version.`,
        action: `Name one of ${liveVersions(read).join(", ")}.`,
      });
    }
    const before = await step.do("retire-guard", () => readGuard(deps, liveVersions(read)));
    const rotationId = await step.do("retire-start", async () => {
      const claimed = await claimPass(deps, "manual", rotatedBy, Object.keys(read.versions).length, options.rotatedBy);
      if (claimed === null) throw alreadyRunning();
      return claimed;
    });
    const retired = withoutVersions(read, [command.version]);
    try {
      await step.do("retire-write", () => writeOver(deps, read, retired, { rotationId, at: now }));
      await step.do("retire-audit", () =>
        deps.emit({
          action: SecretsAuditActions.fieldKeyRetired,
          outcome: "success",
          severity: "critical",
          actorType: "system",
          resourceType: "secret",
          resourceId: FIELD_KEYS_BINDING,
          metadata: {
            version: command.version,
            pastGuard: true,
            stale: before.columns.reduce((sum, column) => sum + (column.stale ?? 0), 0),
            reasons: before.verdict.reasons.join(","),
          },
        }),
      );
      await step.do("retire-close", () => deps.tracker.markSuccess(rotationId));
    } catch (cause) {
      await step.do("retire-failure", () => deps.tracker.markFailure(rotationId, "field-key-incomplete"));
      throw cause;
    }
    return report("retired", retired, [command.version]);
  }

  if (command.mode === "backfill") {
    const read = await step.do("key-set", () => deps.reader.read());
    await backfill(deps, step, read, tuning);
    const versions = liveVersions(read);
    const due = versionsDue(versions);
    const guard = await step.do("backfill-guard", () => readGuard(deps, versions));
    if (due.length === 0 || guard.verdict.reasons.length > 0) return report("backfilled", read, []);
    // A pass already holding the ledger is a rotation or a retirement, and it retires what is due itself.
    const rotationId = await step.do("backfill-start", () =>
      claimPass(deps, "cron", rotatedBy, versions.length, options.rotatedBy),
    );
    if (rotationId === null) return report("backfilled", read, []);
    const retired = withoutVersions(read, due);
    try {
      await step.do("backfill-retire", () => writeOver(deps, read, retired, { rotationId, at: now }));
      await step.do("backfill-audit", () => emitRetired(deps, due));
      await step.do("backfill-close", () => deps.tracker.markSuccess(rotationId));
    } catch (cause) {
      await step.do("backfill-failure", () => deps.tracker.markFailure(rotationId, "field-key-incomplete"));
      throw cause;
    }
    return report("backfilled", retired, due);
  }

  // rotate
  const rotationId = await step.do("start", async () => {
    const claimed = await claimPass(
      deps,
      "cron",
      rotatedBy,
      Object.keys(deps.config.versions).length,
      options.rotatedBy,
    );
    if (claimed === null) throw alreadyRunning();
    return claimed;
  });
  const pass: RotationPass = { rotationId, at: now };
  let failure: RotationFailureCode = "field-key-incomplete";
  try {
    // Read after the claim, so no other writer can move it between this read and this pass's writes.
    const read = await step.do("key-set", () => deps.reader.read());
    const startVersions = liveVersions(read);
    // A version past the window at the start of a rotation is one the previous period could not retire.
    const overdue = versionsDue(startVersions).length > 0;
    // At the ceiling no version is added, but the backfill and a clean retirement still run: that is the only way
    // the rows holding the old versions are re-sealed, so a refusal that skipped them would refuse forever.
    const atCeiling = startVersions.length >= MAX_LIVE_FIELD_KEY_VERSIONS;
    let current = read;

    if (!atCeiling) {
      // 1. Add a version: staged, confirmed, promoted, confirmed.
      const staged = await step.do("stage-next-key", async () => {
        const next = String(highestVersion(read) + 1);
        return {
          next,
          config: {
            currentVersion: read.currentVersion,
            versions: { ...read.versions, [next]: await generateKeyB64() },
            lastRotatedAt: read.lastRotatedAt,
          } satisfies EncryptionConfig,
        };
      });
      await step.do("write-staged", () => deps.writer.write(staged.config, pass));
      failure = "field-key-unconfirmed";
      await confirmed(
        step,
        deps.reader,
        "confirm-staged",
        (shown) => shown.versions[staged.next] !== undefined,
        attempts,
        delayMs,
      );
      current = { ...staged.config, currentVersion: staged.next, lastRotatedAt: now.toISOString() };
      const promoted = current;
      await step.do("write-promoted", () => deps.writer.write(promoted, pass));
      await confirmed(
        step,
        deps.reader,
        "confirm-promoted",
        (shown) => shown.currentVersion === staged.next,
        attempts,
        delayMs,
      );
      failure = "field-key-incomplete";
    }

    // 2. Re-seal only what is leaving.
    await backfill(deps, step, current, tuning);

    // 3. Retire it on a clean guard, and never otherwise.
    const versions = liveVersions(current);
    const due = versionsDue(versions);
    const guard = await step.do("guard", () => readGuard(deps, versions));
    let retired: number[] = [];
    if (due.length > 0 && guard.verdict.reasons.length === 0) {
      const remaining = withoutVersions(current, due);
      await step.do("retire", () => deps.writer.write(remaining, pass));
      await step.do("retire-audit", () => emitRetired(deps, due));
      current = remaining;
      retired = due;
    } else if (due.length > 0) {
      await step.do("blocked-audit", () => emitBlocked(deps, guard.verdict, due, overdue));
    }

    if (atCeiling && retired.length === 0) {
      await step.do("mark-ceiling", () => deps.tracker.markFailure(rotationId, "field-key-ceiling"));
      return {
        outcome: "refused",
        liveVersions: versions,
        retired: [],
        verdict: guard.verdict,
        columns: guard.columns,
        unrotatable: [...deps.stamp.unrotatable],
        unread: [...deps.stamp.unread],
      };
    }
    // A version that was already overdue and is still live is a failure, not a backlog.
    const stillOverdue = overdue && versionsDue(liveVersions(current)).length > 0;
    if (stillOverdue) await step.do("mark-overdue", () => deps.tracker.markFailure(rotationId, "field-key-overdue"));
    else await step.do("mark-success", () => deps.tracker.markSuccess(rotationId));
    // At the ceiling the pass added no version: it cleared the backlog, and the next night's rotation adds one.
    return report(atCeiling ? "backfilled" : "rotated", current, retired);
  } catch (cause) {
    await step.do("mark-failure", () => deps.tracker.markFailure(rotationId, failure));
    throw cause;
  }
}
