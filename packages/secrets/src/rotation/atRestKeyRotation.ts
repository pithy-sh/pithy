// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import type { EncryptionConfig } from "../crypto/envelope";
import { AT_REST_ROTATION_NAME } from "../data/secretRotations";
import type { SecretsTables } from "../data/tables";
import { MASTER_KEY_BINDING } from "../env/masterKeyBinding";
import { SecretCryptoError } from "../error/errors";
import type { ConfigReader } from "../manager/configReader";
import { configStamp, type RotationPass, sameConfigStamp } from "../manager/configStamp";
import type { ConfigWriter } from "../manager/configWriter";
import type { RotationTracker } from "../store/rotationTracker";
import {
  countOnKeyVersions,
  MAX_KEY_SET_SIZE,
  promoteStagedKey,
  pruneRetiredKeys,
  reencryptBatch,
  retiredVersions,
  stageNextKey,
} from "./keyRotation";
import type { RotationFailureCode } from "./rotationLedger";

type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/**
 * A durable step runner — the structural subset of Cloudflare's `WorkflowStep` we use. The Workflow class
 * passes the real runtime step; tests pass a synchronous mock that runs each callback immediately.
 * Keeping it structural avoids a hard dependency on `cloudflare:workers`.
 */
export interface StepRunner {
  /** Run a named step, or serve the journalled result of one this instance already completed. */
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Pause the instance and resume it afterwards — **between** steps, never inside one.
   *
   * The second member exists for one caller: the read-back below (`#647`). A wait that matters has to
   * cross a journal boundary. The master key arrives through a binding whose value an isolate may hold
   * for its whole life, so a timer inside one step re-reads one cached answer however long it loops —
   * while a Workflow resume may land in a fresh isolate, which is the only wait that can change what the
   * binding says.
   */
  sleep(name: string, durationMs: number): Promise<void>;
}

/** Everything the at-rest rotation needs, injected so the core is testable without CF wiring. */
export interface AtRestRotationDeps {
  /** The per-environment secrets D1. */
  db: SecretsDb;
  /** The current master-key config (resolved from `SECRETS_ENCRYPTION_KEYS`). */
  config: EncryptionConfig;
  /** Writes the updated config back to CF Secrets Store, over REST, by composed entry name. */
  configWriter: ConfigWriter;
  /**
   * Reads the config back **through the binding** — the other end of the write, and the only end that can
   * confirm content. See `manager/configReader.ts` for why REST cannot do it, and why this is a second
   * seam rather than a method on the first.
   */
  configReader: ConfigReader;
  /** Records the rotation attempt in `pithy_secrets_rotations`. */
  tracker: RotationTracker;
}

export interface AtRestRotationOptions {
  batchSize?: number;
  maxBatches?: number;
  /**
   * Who is running this pass — **the Workflow instance's own id**, and nothing recomposed from the pass's
   * inputs (#647 review).
   *
   * It is the single-flight holder: `RotationTracker.claimRotation` hands an open row back to the holder
   * that opened it, so that a step retry cannot wedge the rotation by declining against its own row. That
   * reclaim is sound only while one holder string names exactly one pass. A value derived from the pass's
   * *inputs* — the pointer and the date, say — is shared by every pass with those inputs, which lets a
   * second instance take over a running pass's row and run beside it.
   *
   * `runRotationWorkflow` passes `event.instanceId`. A caller that supplies nothing is a test or a local
   * driver, and gets a constant, which is correct there: nothing else is contending.
   */
  rotatedBy?: string;
  /**
   * The clock, for a test that wants a fixed one.
   *
   * Read **inside** the `pass-instant` step rather than beside it, so journalling this value did not
   * close the seam: an injected clock is still what gets read and still what gets journalled.
   */
  now?: Date;
  /** How many times a read-back asks the binding before the pass gives up. Defaults to five. */
  readBackAttempts?: number;
  /** How long a pass waits between two read-back attempts, in milliseconds. Defaults to fifteen seconds. */
  readBackDelayMs?: number;
}

export interface AtRestRotationResult {
  rotated: number;
  failed: number;
  newCurrentVersion: number;
  /**
   * Whether this pass retired a generation of keys. **Ordinarily `false` on the pass that rotated**: the
   * prune is deferred a full generation, so it is the *next* pass that drops what this one superseded.
   */
  pruned: boolean;
  /**
   * How many rows kept this pass from retiring the generation it was due to retire — `0` when nothing was
   * due, and `0` when the prune went ahead.
   *
   * **The count is the whole point (`#647`).** A row that will not decrypt holds a version forever: the
   * prune gate refuses while any row sits on a retiring key, and it is right to — a corrupt ciphertext is
   * not a missing key, and deleting the key makes a recoverable row certainly unrecoverable. So the pass
   * closes `success` and the key set gains an entry every cadence, which fails *toward* keeping keys and
   * is exactly why nobody would notice for a year.
   *
   * **What this number is, stated exactly, because it is easy to over-claim.** It is a result field. The
   * Workflow's `run` returns `void` and drops it, so nothing alerts on it and no operator meets it here.
   * Three other things carry that weight and they are where the signal actually lives: every pass journals
   * `keySetSize` into its ledger row, so a set growing each cadence is in the history an incident review
   * reads; `pithy secrets verify` reports the versions the resolved config holds, which is where an
   * operator looks; and {@link MAX_KEY_SET_SIZE} refuses before minting, which turns a slow leak into a
   * loud failure well before anything is at risk. This field is for a caller and a test.
   */
  retirementBlocked: number;
}

/**
 * How many times a read-back asks, and how long it waits between asking.
 *
 * Five attempts with fifteen seconds between them is four waits — a minute of propagation tolerance,
 * generous for a store that is normally consistent and cheap on a job that runs monthly. The budget is
 * not a retry budget; see {@link confirmedThroughBinding} for what it counts.
 */
const DEFAULT_READ_BACK_ATTEMPTS = 5;
const DEFAULT_READ_BACK_DELAY_MS = 15_000;

/** One read-back's budget. */
interface ReadBackPolicy {
  /** Total read attempts, each its own durable step. */
  attempts: number;
  /** The pause between two attempts, spent as a durable sleep. */
  delayMs: number;
}

/**
 * The deterministic Workflow instance id for a pass superseding `pointer` on the UTC day of `at`.
 *
 * **Single-flight, at the only place that can hold it (`#647`).** Two overlapping passes each confirm
 * their own read-backs, and the master-key entry takes a full-value replace with no conditional write
 * available — so the slower pass's promoted write deletes the key every row is by then sealed under, its
 * own read-back confirms the clobber, and the pass reports success. An undecryptable store, signaled
 * green.
 *
 * **It is the cheap half of the guard and never the whole of it.** Cloudflare refuses a duplicate instance
 * id, so two triggers in one day over one pointer cost one Workflow instead of two — but the id carries a
 * UTC day, and two triggers either side of midnight compose two ids. The lock that has no such seam is
 * `RotationTracker.claimRotation`, which writes the pass's own ledger row only where the name holds no open
 * one, in one statement. This stays because declining before an instance exists is cheaper than declining
 * inside one, not because anything rests on it.
 *
 * The pointer is in the id so a pass that genuinely moved the key can be followed by another; the date is
 * in it so a failed pass can be retried tomorrow rather than never.
 */
export function atRestInstanceId(pointer: string, at: Date): string {
  return `at-rest-${pointer}-${at.toISOString().slice(0, 10)}`;
}

/**
 * Poll the binding until it shows the write, or the budget is spent — and **abort from inside the last
 * read's step** when it is.
 *
 * **This is the one bounded thing in the pass, and the boundary is drawn exactly here.** Every other
 * failure in this Workflow is transient by construction — the CF API is unreachable, the store would not
 * answer, D1 is busy — and those are the platform's business: the step body throws, `classifiedSteps`
 * classifies it retryable, and the engine re-drives it with backoff. None of them consumes an attempt,
 * because an attempt is only spent by a read that **succeeded and did not show the write**. That failure
 * has exactly two causes: propagation, which resolves, and a write that landed somewhere the binding does
 * not read, which never will. Retrying the second forever turns a nightly cron into a loop that rewrites
 * the wrong entry on every pass, so the budget exists to tell them apart by waiting — and spending it is
 * an **abort**, not another retry.
 *
 * Each attempt is its own `step.do`, with a `step.sleep` between. **The reason is durability, not staleness,
 * and that was checked rather than assumed (#647).** This was written believing a binding might hold one
 * value for its isolate's life, which would make a loop inside one step re-read one answer forever. It does
 * not: measured against a real Secrets Store on 2026-09-25, a binding refreshes inside a live isolate about
 * 1.3-1.5s after the REST write — two isolates held warm through a write each served the old value before it
 * and the new one after, across 328 samples. So an in-step loop would in fact work.
 *
 * The shape stays because a journalled wait is still the better one: a `step.sleep` survives the instance
 * being evicted mid-wait, where a `setTimeout` inside a step burns that step's wall clock and dies with it.
 * What changed is the claim, not the code — a docblock that justifies a design with a fact nobody checked is
 * how the next reader inherits a belief instead of a reason.
 *
 * **The refusal is raised inside the final step, and that is not a detail.** Thrown from the driver body
 * it is never classified, never becomes the platform's terminal error, and the engine is free to re-drive
 * the whole instance — one fresh key and one more orphan write per attempt, which is the failure the
 * budget exists to remove, reintroduced one level up.
 */
async function confirmedThroughBinding(
  step: StepRunner,
  reader: ConfigReader,
  label: string,
  landed: (config: EncryptionConfig) => boolean,
  policy: ReadBackPolicy,
  refuse: () => never,
): Promise<void> {
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    if (attempt > 0) await step.sleep(`${label}-wait-${attempt}`, policy.delayMs);
    const last = attempt === policy.attempts - 1;
    const seen = await step.do(`${label}-${attempt}`, async () => {
      const shown = landed(await reader.read());
      if (!shown && last) refuse();
      return shown;
    });
    if (seen) return;
  }
}

/**
 * Check the REST-visible stamp on the entry that was just written.
 *
 * **It may refuse and it may never satisfy.** A matching comment does not prove the value beside it —
 * Cloudflare serves no value over REST — so this never substitutes for the binding read-back that follows
 * it. What it catches is a stamp that disagrees with the write this pass just made: an entry edited out
 * of band between two passes, or a REST edit that reached a different entry than the one inspected.
 * A stamp that is absent or unreadable refuses nothing, because "no stamp" is what an operator's own note
 * in the dashboard looks like.
 *
 * Unretried, and inside a step so the refusal is classified: a mismatch is structural, and the second
 * look answers the same.
 */
async function confirmedThroughStamp(
  step: StepRunner,
  writer: ConfigWriter,
  label: string,
  config: EncryptionConfig,
  pass: RotationPass,
): Promise<void> {
  const expected = configStamp(config, pass);
  if (expected === null) return;
  await step.do(`${label}-stamp`, async () => {
    const facts = await writer.inspect();
    const found = facts?.stamp ?? null;
    if (found === null || sameConfigStamp(found, expected)) return;
    throw new SecretCryptoError({
      message: "The master key entry does not carry the stamp this rotation just wrote.",
      action: `Read this environment's master-key entry in the Cloudflare dashboard and compare its comment with the rotation row; the entry is being written by something other than this pass.`,
      detail: `at-rest rotation: entry '${writer.entryName}' carries rotation ${found.rotationId} at ${found.at} pointing at ${found.currentVersion}; this pass is rotation ${expected.rotationId} at ${expected.at} pointing at ${expected.currentVersion}`,
    });
  });
}

/** Whether a key set holds a usable key under `version`. Empty is absent: a blank key decrypts nothing. */
function holdsKey(config: EncryptionConfig, version: string): boolean {
  const key = config.versions[version];
  return key !== undefined && key.length > 0;
}

/**
 * Rotate the at-rest encryption key for one environment's store, in durable steps.
 *
 * ## The sequence, and why the order is the fix (`#647`)
 *
 *   1. read the config: `{ currentVersion: N, versions: { …, N } }`;
 *   2. generate key N+1;
 *   3. write `{ currentVersion: N, versions: { N, N+1 } }` — the key is published, the pointer has **not**
 *      moved, and neither has `lastRotatedAt`;
 *   4. **read it back through the binding** and assert N+1 is there. If it is not, abort — nothing has
 *      been re-encrypted, so the store is exactly as it was;
 *   5. re-encrypt every row under an **in-memory** `{ currentVersion: N+1, … }` envelope;
 *   6. write `{ currentVersion: N+1, versions: { N, N+1 } }`;
 *   7. read that back and assert the pointer moved;
 *   8. prune later — never in the pass that created the successor.
 *
 * This pass used to persist `{ currentVersion: N+1, … }` **before** re-encrypting a single row, never read
 * it back, and prune N in the same breath. The write upserted, so a write addressed to an entry name the
 * binding does not read returned 200 and created an orphan — and the pass went on to seal every row under
 * a key nothing bound. A whole environment's secrets became undecryptable, silently.
 *
 * The order is what removes it. After step 4 the binding **holds key N+1**, and `decryptValue` resolves
 * `versions[row.keyVersion]` rather than the pointer, so from that moment every row is readable whatever
 * happens next: an interruption at step 5 leaves a half-rotated store that reads, and an abort at step 7
 * leaves a fully re-encrypted store that reads, with the pointer still on N and new writes still sealing
 * under N. A failed rotation, not an outage.
 *
 * Each step is retryable and idempotent: re-encryption only touches rows not yet on the promoted version,
 * and every prior key stays available until a prune a generation later. Scoped to one environment — the
 * per-env manager owns one store; cross-env fan-out is the CLI's job.
 *
 * ## One known exposure, stated rather than discovered
 *
 * `stage-next-key` journals the staged key set, so the master keys of a pass sit in Cloudflare's Workflow
 * journal for that instance's retention. That is what this step already did before `#647` — the branch
 * renamed it and changed its return type, and did not make the exposure worse.
 *
 * **The remedy is cheaper than this note first claimed, and the claim was wrong (#647 review).** It said
 * the only fix was to journal the version alone and re-read the set from the binding, which the
 * determinism gate (`cli/src/ci/workflowDrivers.ts`) forbids outside a step. That argued against one
 * alternative and missed the obvious one: `WorkflowStepConfig.sensitive` — `"output"` — redacts a step's
 * output from the journal, and it is in the pinned `@cloudflare/workers-types` (`index.d.ts:14763`, with
 * the three-argument `do` at `:14827`) and validated by wrangler. It needs no re-read and no change to the
 * gate's rule. What it does need is a `WorkflowStepConfig` threaded through `StepRunner`,
 * `DurableStepLike`, `WorkflowStepLike` and `classifiedSteps`, and the gate's *discovery* heuristic
 * widened, since it recognizes a step runner by a two-argument `do`. Four interfaces, not a redesign.
 *
 * Who can read it, stated accurately: this project mints no Workflows permission at all
 * (`cloudflare/src/tokens/permissions.ts`), and every credential it does mint that could reach the journal
 * already carries `secrets:read`. The real delta over the Secrets Store is privilege separation inside one
 * account — D1 Read plus Workflows visibility recovers both halves with no Secrets Store Read — and that a
 * journal outlives the prune, so retiring a key does not retire the copy in an earlier pass's journal.
 */
export async function runAtRestKeyRotation(
  deps: AtRestRotationDeps,
  step: StepRunner,
  options: AtRestRotationOptions = {},
): Promise<AtRestRotationResult> {
  const batchSize = options.batchSize ?? 100;
  const maxBatches = options.maxBatches ?? 50;
  // The pass's own identity when it has one — the Workflow instance id, supplied by `runRotationWorkflow`.
  // It is what makes the claim retakable after a lost step journal, and it is deliberately `undefined` for
  // a caller that cannot name one pass: the ledger column's default is a constant, so reclaiming on it
  // would let any pass take over any other. See `RotationTracker.claimRotation`.
  const passIdentity = options.rotatedBy;
  const rotatedBy = passIdentity ?? "cron";
  const readBack: ReadBackPolicy = {
    attempts: options.readBackAttempts ?? DEFAULT_READ_BACK_ATTEMPTS,
    delayMs: options.readBackDelayMs ?? DEFAULT_READ_BACK_DELAY_MS,
  };
  // A budget of zero confirms nothing and aborts a healthy pass without asking; a negative one is the
  // same fact spelled worse. Refused rather than clamped, the way `isRotationDue` refuses an interval.
  if (!Number.isInteger(readBack.attempts) || readBack.attempts < 1) {
    throw new InternalError({
      message: "The secrets manager is misconfigured.",
      action: "Set the rotation's readBackAttempts to a whole number of attempts, one or more.",
      detail: `readBackAttempts resolved to ${String(readBack.attempts)}; a read-back that never asks confirms nothing.`,
    });
  }

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
   * running work. The sibling case in the email worker looked equally plain and was not.
   *
   * Epoch milliseconds rather than a `Date`, because a journal round-trips JSON: a `Date` would come back
   * a string on the resume and an object on the first pass.
   */
  const nowMs: number = await step.do("pass-instant", async () => (options.now ?? new Date()).getTime());
  const now = new Date(nowMs);

  /**
   * The rotation row, which **is** the single-flight lock (`#647`).
   *
   * One statement takes it: `claimRotation` writes this pass's row only where the sentinel holds no open
   * one, so two contenders serialize and exactly one gets an id. It replaced a read of `liveRotation`
   * followed by an insert, which had two holes — a six-hour staleness window a long pass outlives, and the
   * gap between the select and the insert — and the thing on the other side of both holes is a second pass
   * whose promoted write deletes the key every row is sealed under. The tracker states the argument.
   *
   * Inside the step for two reasons. It is journalled, so a resume of *this* pass does not re-ask and
   * decline itself. And the refusal is raised where `classifiedSteps` can see it, so the losing instance
   * stops on its first attempt instead of being re-driven into the same answer.
   *
   * The snapshot is the key set's **size** and nothing from the key set, so the growth this pass is part of
   * is in the history a reviewer reads. `RotationSnapshot` is why that is a count rather than a key.
   */
  const rotationId = await step.do("start", async () => {
    const claimed = await deps.tracker.claimRotation(
      AT_REST_ROTATION_NAME,
      "cron",
      rotatedBy,
      { keySetSize: Object.keys(deps.config.versions).length },
      passIdentity,
    );
    if (claimed === null) {
      throw new ConflictError({
        message: "An at-rest key rotation is already running for this environment.",
        action: "Nothing to run. Wait for the running pass to finish; the next scheduled one starts after it.",
        detail: "at-rest rotation: this environment's rotation ledger already holds an open pass",
      });
    }
    return claimed;
  });

  const pass: RotationPass = { rotationId, at: now };

  /**
   * Which sentence the rotation row gets if this pass throws.
   *
   * A variable rather than a question asked of the exception, because the catch below may not look at one
   * (`#386`). An abort on an unconfirmed write is the failure an operator most needs to tell from the
   * rest — it is the one with a cadence consequence — so the path that raises it says so on the way past,
   * and the catch writes a code exactly as it always did. Re-executed from the top on a resume along with
   * everything else in this body, and set again on the same path, so a replay records the same code.
   */
  let failure: RotationFailureCode = "at-rest-incomplete";

  try {
    // 1b. The ceiling on the key set, checked **before a key is minted** — because a ceiling checked
    // afterwards is a ceiling that has already been exceeded. See `MAX_KEY_SET_SIZE`.
    await step.do("key-set-bound", async () => {
      const held = Object.keys(deps.config.versions).length;
      if (held < MAX_KEY_SET_SIZE) return;
      // The versions below the pointer, and the rows still sealed under them. At the start of a healthy
      // pass that count is zero — every row is on the current key — so a positive one is exactly the set
      // of rows that has been blocking the prune, cadence after cadence.
      const blocked = await countOnKeyVersions(deps.db, retiredVersions(deps.config, deps.config.currentVersion));
      throw new SecretCryptoError({
        message:
          "The master key set has reached its limit. Rows that will not re-encrypt are blocking every retirement.",
        action:
          "Read this environment's rotation history, find the rows still sealed under a superseded key version, and repair them. Then rotate again. Do not delete a key: a row that will not decrypt today may still be recoverable, and its key is the only thing that could open it.",
        detail: `at-rest rotation: the key set holds ${held} versions against a ceiling of ${MAX_KEY_SET_SIZE}; rows still sealed under a superseded version: ${blocked}. No key was minted and the store is unchanged.`,
      });
    });

    // 2 + 3. The key is published under a version nothing points at yet.
    const staged = await step.do("stage-next-key", () => stageNextKey(deps.config, now));
    const nextVersion = staged.nextVersion;
    const supersededVersion = staged.staged.currentVersion;
    await step.do("write-staged-config", () => deps.configWriter.write(staged.staged, pass));

    // The REST half: it may refuse this pass, and it can never let it through. See the function.
    await confirmedThroughStamp(step, deps.configWriter, "confirm-staged", staged.staged, pass);

    // 4. The gate on every byte of work below. Nothing has been re-encrypted, so an abort here costs the
    // store nothing at all: the pointer is on N, the rows are on N, and a later pass starts over.
    await confirmedThroughBinding(
      step,
      deps.configReader,
      "confirm-staged",
      (config) => holdsKey(config, nextVersion),
      readBack,
      () => {
        failure = "at-rest-unconfirmed";
        throw new SecretCryptoError({
          message: "The rotated master key did not come back through the binding.",
          action: `Check that the manager's PROJECT and ENVIRONMENT vars name the Secrets Store entry its ${MASTER_KEY_BINDING} binding reads, then redeploy it with \`pithy secrets provision\`.`,
          detail: `at-rest rotation: key version ${nextVersion} was written to '${deps.configWriter.entryName}' and ${readBack.attempts} reads of ${MASTER_KEY_BINDING} did not hold it; nothing was re-encrypted and the store is unchanged`,
        });
      },
    );

    // 5. The promoted envelope exists only in memory, and only because the staged set holds the key it
    // names — `promoteStagedKey` refuses otherwise. Handing the staged envelope here instead would select
    // the rows that are not on N, find none, and report a rotation that moved nothing.
    const promoted = promoteStagedKey(staged);

    let rotated = 0;
    let failed = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const result = await step.do(`reencrypt-${batch}`, () => reencryptBatch(deps.db, promoted, batchSize));
      rotated += result.rotated;
      failed += result.failed;
      // Stop when a batch makes no progress — either the store is fully rotated, or only
      // failures remain (which would loop forever).
      if (result.rotated === 0) break;
    }

    // 6. The pointer moves last, over rows that are already on the key it names.
    await step.do("write-promoted-config", () => deps.configWriter.write(promoted, pass));
    await confirmedThroughStamp(step, deps.configWriter, "confirm-promoted", promoted, pass);

    // 7. Both halves, because either one missing is the same incident: the pointer must name N+1, and the
    // key must still be there to back it.
    await confirmedThroughBinding(
      step,
      deps.configReader,
      "confirm-promoted",
      (config) => config.currentVersion === nextVersion && holdsKey(config, nextVersion),
      readBack,
      () => {
        failure = "at-rest-unconfirmed";
        throw new SecretCryptoError({
          message: "The rotated master key was stored but the key set still names the previous version.",
          action: `Read this environment's ${MASTER_KEY_BINDING} entry and compare its currentVersion with the manager's last rotation row; the stored secrets are readable, so there is no emergency and no second rotation to run.`,
          detail: `at-rest rotation: every row is on key version ${nextVersion} and ${readBack.attempts} reads of ${MASTER_KEY_BINDING} still named ${supersededVersion}; the binding holds key ${nextVersion} (confirmed before re-encrypting), so every row still decrypts and new writes still seal under ${supersededVersion}`,
        });
      },
    );

    // 8. The deferred prune, floored on the pointer this pass **superseded** rather than on the key set
    // (D10) — inferring it collapses the deferral to zero on exactly the abandoned-stage state this
    // sequence produces. `retiredVersions` is empty on the pass that rotated, so this is ordinarily a
    // count and nothing more.
    //
    // The prune write is deliberately not read back. It removes keys, so a write that does not land
    // leaves a key set merely larger than it needs to be, which breaks nothing; and the two read-backs
    // above already proved, this pass, that writes to this entry reach the binding.
    //
    // A blocked prune is **reported**, never overridden. The rows that block it are rows that would not
    // re-encrypt, and their key is the only thing that could still open them — so the count travels and the
    // key stays. `MAX_KEY_SET_SIZE` is the other half: this pass says how many rows are in the way, and the
    // next pass that would grow the set past the ceiling refuses instead, which is what turns a number
    // nothing reads into a failed row the manifest publishes.
    let pruned = false;
    let retirementBlocked = 0;
    const retired = retiredVersions(promoted, supersededVersion);
    if (retired.length > 0) {
      const stranded = await step.do("count-retired", () => countOnKeyVersions(deps.db, retired));
      if (stranded === 0) {
        const prunedConfig = pruneRetiredKeys(promoted, supersededVersion);
        if (prunedConfig) {
          await step.do("prune", () => deps.configWriter.write(prunedConfig, pass));
          pruned = true;
        }
      } else retirementBlocked = stranded;
    }

    await step.do("mark-success", () => deps.tracker.markSuccess(rotationId));
    return { rotated, failed, newCurrentVersion: Number(promoted.currentVersion), pruned, retirementBlocked };
  } catch (cause) {
    // **The binding rethrows and does nothing else (`#386`).** It used to become the row's `error_message`
    // via `cause.message`, and the exceptions that reach here come from decryption, envelope decoding and
    // config parsing — the paths whose text can carry key material. `markFailure` now takes a code and
    // renders the sentence itself, so there is no argument this `cause` would fit. The code is chosen by
    // the path above rather than read off the exception, for the same reason.
    //
    // Rethrown unchanged, which is where the detail belongs: the Workflow logs a `PithyError` whose
    // `detail` the HTTP codec strips. Nothing about this failure is written to a column, and the column
    // is still refused for publication — that refusal is defense in depth, not this fix.
    await step.do("mark-failure", () => deps.tracker.markFailure(rotationId, failure));
    throw cause;
  }
}
