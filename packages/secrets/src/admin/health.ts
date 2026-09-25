// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { type CapabilityHealth, defineCapabilityHealth } from "@pithy-sh/core/src/controlPlane/discovery/health";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import type { Context } from "hono";
import { z } from "zod";
import { AT_REST_ROTATION_NAME, RotationStatus, type RotationTrigger } from "../data/secretRotations";
import { secretsStatusDatabase } from "../data/statusDb";
import type { SecretsStoreEnv } from "../env/bindings";
import { SECRETS_STATUS_READ_SCOPE } from "../http/guards";
import { bindingConfigReader } from "../manager/configReader";
import type { SecretRegistry } from "../registry";
import { isRotationDue } from "../rotation/keyRotation";
import { readSecretStatus, type SecretStatusEntry, type SecretsStatusDb } from "./status";

/**
 * What this capability contributes to its manifest entry: one number and one outcome, so a management
 * client can say "3 secrets need rotating" and "last night's master-key rotation did not finish" from
 * the read it already made (#317, #647).
 *
 * ## Why a count and a state belong on the manifest, and the lists behind them do not
 *
 * The lists are `GET {base}/admin/status` and `GET {base}/admin/status/:name/rotations`, and they stay
 * there. What a rail needs is whether the detail is worth fetching, and that is a scalar. Anything more
 * — which secrets, since when, why — grows with the adopter's registry and would turn a discovery read
 * into a data API.
 *
 * ## Two keys, two questions, and the second is the one nothing else asks
 *
 * {@link SECRETS_DUE_FOR_ROTATION} is a cadence question about the secrets an adopter declared.
 * {@link LAST_AT_REST_ROTATION} is about the store itself — whether the machinery that re-encrypts every
 * row under a fresh master key finished. #647 is why the second exists: every control that issue adds
 * ends in an **abort**, an abort is correct because nothing is damaged, and an abort is silent. The
 * rotation is an unattended cron with nobody watching its failures. With only the count, a rotation that
 * correctly aborts every night stays invisible for up to `ROTATION_INTERVAL_DAYS`. A fix nobody hears
 * about is most of a fix wasted.
 *
 * ## One definition of late
 *
 * The count is derived from {@link readSecretStatus} rather than from a second query that re-decides
 * what overdue means. A secret whose registry entry declares no cadence, or that has nothing to measure
 * from, reports `overdue: null` there and is not counted here: nobody has said what late means for it,
 * and counting it would be an opinion the capability does not hold.
 */

/** The key the count appears under. Exported so a client and a test name it from one place. */
export const SECRETS_DUE_FOR_ROTATION = "secretsDueForRotation";

/** The key the last at-rest rotation's outcome appears under. Exported for the same reason. */
export const LAST_AT_REST_ROTATION = "lastAtRestRotation";

/**
 * How the last at-rest master-key rotation ended — the closed member list the manifest key declares.
 *
 * **An outcome, and never a reason.** `RotationTracker.markFailure` takes a code rather than a sentence
 * because the exceptions on that path come from decryption, envelope decoding and config parsing — the
 * paths whose text can carry key material (#386) — and that does not relax because the value now appears
 * on a manifest. It tightens: the manifest is read by a management client across a trust boundary, which
 * is a wider audience than the column ever had. So {@link latestAtRestRotation} selects two columns —
 * `status` and `completed_at`, the two this capability writes when it closes a row — and maps them into
 * this union. There is no member a free-text string could reach.
 *
 * ## Why these seven, and not the column's three
 *
 * Four of them have no readable row behind them, so this could never have been `RotationStatus`
 * re-exported:
 *
 * - `succeeded`, `failed`, `inProgress` are the ledger's own three lifecycle states, renamed for the
 *   wire. `inProgress` is a pass that is open: running, retrying a transient failure, or dead between
 *   steps. The key does not distinguish those three and does not pretend to — it says *look at the
 *   Workflow*. An interrupted pass reports `inProgress` until its row closes — and under the single-flight
 *   claim in `RotationTracker.claimRotation` an open row is the lock, held with no expiry, so the next cron
 *   declines rather than opening a newer one. A pass that died between steps therefore reports `inProgress`
 *   until the Workflow's own retries close it or an operator does. That is the honest reading of the state
 *   and it is deliberate: a lock that timed out would be a lock a long pass outlives, and the thing on the
 *   other side of that hole is two passes clobbering one key set. This key says which pass to go and look at.
 * - `stale` is a pass that closed `success` and closed too long ago, which is the *cron* failing rather
 *   than the *rotation* failing. See below: it is the second half of the same defect.
 * - `neverRun` is the absence of any row. A store provisioned last week reports it, and so does a
 *   manager Worker whose cron was never wired. Folding it into `succeeded` would report the second as
 *   healthy forever, which is the whole defect this key exists to remove.
 * - `unreadable` is a row this capability did not write: a `status` outside {@link RotationStatus}, a
 *   `completed_at` that will not decode, or a `success` with no completion instant at all — `markSuccess`
 *   writes the status and the instant in one statement, so a row holding one without the other is not a
 *   row this code produced. That is a fact about the row, not about the rotation, and it carries nothing
 *   with it — what the decode rejected is a column value from a row whose neighbors are `error_message`
 *   and `metadata_snapshot`.
 * - `masterKeyUnresolvable` is the headline case, below.
 *
 * ## `stale`: a cron that stopped firing must not read as healthy
 *
 * The rest of this key reports the last pass's **outcome**, and that is blind to the pass that never
 * happened. Remove the `AT_REST_ROTATION` binding, drop the cron trigger, stop deploying the manager
 * Worker at all: the newest ledger row stays `success`, and this key reports `succeeded` forever.
 * `masterKeyUnresolvable` covers a dead key; nothing covered a dead schedule. It is the same failure as
 * the rest of #647 — silence reading as healthy — one layer out, and an operator watching this key would
 * never learn the rotation had stopped.
 *
 * So the outcome carries the one thing that can say so: **how long ago** the last pass closed, measured
 * against the cadence the project configured. `stale` is *the last pass succeeded, and nothing has
 * succeeded since, for longer than this project's own cadence allows*.
 *
 * **The name.** Not `overdue`, which is the word {@link SECRETS_DUE_FOR_ROTATION} and `SecretStatusEntry`
 * already own for a different subject — an adopter's declared secret past *its* registry cadence — and
 * two keys on one manifest using one word for two subjects is how a dashboard comes to render the wrong
 * number. Not `late`, which reads as a pass that is running behind and will still arrive. `stale` is a
 * claim about the *value this key is reporting*: the `succeeded` underneath is still true and is no
 * longer worth anything, which is exactly the state.
 *
 * ## Precedence: `stale` refines the nominal member and nothing else
 *
 * The resolution order is `masterKeyUnresolvable`, then the ledger's own states, then — for `succeeded`
 * alone — staleness. `masterKeyUnresolvable` stays first for the reason below: a store that cannot open
 * its key has no meaningful last rotation to age. And staleness is applied only where the answer would
 * otherwise be nominal, because every other member already grades `attention` and already says *go and
 * look*. Overriding a `failed` from last year with `stale` would trade the more actionable fact for the
 * less actionable one, and overriding `neverRun` would erase the distinction between a store that has
 * never rotated and one that rotated and then stopped — two different conversations with an operator.
 *
 * ## Why the threshold is two intervals and not one
 *
 * A pass is not stale the instant it is due. The cron fires on its own schedule, `isRotationDue` is
 * consulted on a tick rather than at the boundary, a pass takes time, and a transient failure is retried
 * on the next tick by design. A threshold of one interval would flap to `stale` for the hours or days
 * between *due* and *done*, every single cadence, on a project where nothing is wrong — and a key that
 * cries wolf on schedule is muted within a week, which costs more than it ever bought.
 *
 * Two intervals is the first threshold that cannot be reached by a healthy project: it means a whole
 * cadence came and went with no successful pass, which is *skipped*, not *late*. Three would double the
 * silence this key exists to shorten for no extra certainty. {@link STALE_AFTER_INTERVALS} is the
 * multiple, and `health.test.ts` brackets it — a pass at one and a half intervals is `succeeded`, one at
 * two is `stale` — so the number is pinned by behavior rather than by a comment.
 *
 * ## `masterKeyUnresolvable`, and why the ledger is not asked first
 *
 * When `SECRETS_ENCRYPTION_KEYS` will not resolve — absent binding, non-JSON, or a config that will not
 * parse — `resolveEncryptionConfig` throws, and it throws *before* the rotation opens its ledger row:
 * `manager/worker.ts` resolves it in `scheduled()` and `manager/rotationWorkflow.ts` resolves it again
 * before `runAtRestKeyRotation` starts. So no row is written, no row is closed, and the ledger's last
 * word stays whatever the previous pass said — `succeeded`, graded nominal, for a store whose secrets
 * cannot be decrypted at all. That is the exact state #647 exists to catch, reported as healthy.
 *
 * The fix is to ask the question the ledger cannot answer, in the read that publishes the answer: this
 * capability probes the binding itself and reports `masterKeyUnresolvable` **in preference to** any
 * ledger state. A store that cannot open its own master key has no meaningful last rotation, and the
 * more actionable of the two facts is the one that travels. Nothing derived from the probe's failure is
 * published — the member is a constant, and the `catch` that produces it takes no binding.
 *
 * ## Why there is no `aborted`
 *
 * An abort and a failure are one outcome and two reasons. `RotationStatus` has no `aborted` member, and
 * the only column that could tell them apart is `error_message` — the exact column #386 closed. A member
 * for it would be the reason re-entering through the front door, and it would buy a reader nothing: both
 * say *the last rotation did not succeed, go and look*, and the looking happens in the rotation history
 * and the Workflow's logs, where the context is allowed to be.
 *
 * **`failed` therefore does not say whether the store is mid-rotation.** An abort before anything was
 * re-encrypted and an abort part-way through report identically, and their remedies differ. The key's
 * `summary` says so rather than letting a reader infer that a failure means nothing happened.
 *
 * ## Why `succeeded` is the only nominal member
 *
 * Every other member is a state somebody should look at, and `standingOf` grades each of them
 * `attention`. That includes `neverRun` on a freshly provisioned project, which is deliberate: a master
 * key that has never rotated is a finding, not a default, and grading it nominal would report a project
 * whose manager cron was never wired as healthy forever. It includes `stale` for the same reason one
 * step on: the pass that succeeded is not the pass that should have run since.
 */
export const AtRestRotationOutcome = z
  .enum(["succeeded", "stale", "failed", "inProgress", "neverRun", "unreadable", "masterKeyUnresolvable"])
  .describe(
    "How the last at-rest master-key rotation ended: `succeeded`, `stale` when it succeeded but longer ago than this project's cadence allows — a cron that stopped firing — `failed`, `inProgress` while a pass is open, `neverRun` when none is recorded at all, `unreadable` when the ledger row will not decode, and `masterKeyUnresolvable` when SECRETS_ENCRYPTION_KEYS itself will not resolve — the state in which no pass can even start and the ledger keeps reporting the last one that did. An outcome, never a reason: no text from a failure reaches this value.",
  );
export type AtRestRotationOutcome = z.output<typeof AtRestRotationOutcome>;

/**
 * The one outcome that is not a finding.
 *
 * Typed as the outcome so a rename cannot leave the declaration behind, and `HealthSummaryKey`'s own
 * refine refuses a nominal member the key does not declare — so this is checked twice, once by the
 * compiler and once at assembly.
 */
const AT_REST_NOMINAL: readonly AtRestRotationOutcome[] = ["succeeded"];

/**
 * The column's three lifecycle states, as the manifest names them.
 *
 * A total `Record` rather than a `switch`: a member added to `RotationStatus` becomes a compile error
 * naming this file, which is the only way a new lifecycle state cannot quietly arrive on a manifest as
 * something it is not.
 */
const OUTCOME_OF_STATUS: Record<RotationStatus, AtRestRotationOutcome> = {
  success: "succeeded",
  failed: "failed",
  in_progress: "inProgress",
};

/**
 * What the ledger last said about the whole-store at-rest key rotation.
 *
 * Three answers with three remedies, and the state rides on the value so a caller cannot reach the
 * status without narrowing. `none` is *no pass has ever been recorded*; `unreadable` is *a row is there
 * and its `status` is not one this capability writes*. Neither is a failure, and reporting either as one
 * would be the collapse #350 and #471 each exist to prevent.
 */
export type LatestAtRestRotation =
  | {
      /** The row decoded, and its lifecycle state is below. */
      state: "readable";
      /** How that attempt ended: `in_progress`, `success`, or `failed`. */
      status: RotationStatus;
      /**
       * When the pass closed, or `null` while it is open.
       *
       * The only other column this read selects, and the one that makes `stale` computable. It is an
       * instant and nothing else — not a duration, not a reason — so publishing an *outcome* derived
       * from it publishes no more than the outcome always did.
       */
      completedAt: Date | null;
    }
  | {
      /** A row is there and it is not one this capability writes. Nothing else travels. */
      state: "unreadable";
    }
  | {
      /** No at-rest rotation has ever been recorded in this environment. Not a failure. */
      state: "none";
    };

/** The two triggers a real at-rest pass is filed under. `baseline` is a first write, never a rotation. */
const ROTATION_TRIGGERS: readonly RotationTrigger[] = ["cron", "manual"];

/**
 * The newest at-rest rotation attempt, as one column.
 *
 * **The narrow `select` is the security boundary, not a tidiness.** `error_message` and
 * `metadata_snapshot` are on this row, they are free text written at a failure site, and the value this
 * feeds is published on a manifest. A column that is never selected cannot be projected by anything
 * downstream, whatever a later edit does — the first of the four layers `./status.ts` states, applied to
 * the one table that file deliberately does not report on. `markFailure` takes a code precisely so that
 * nothing here has a reason to publish (#386); this read makes that structural by never holding one.
 *
 * **`completed_at` joined it for `stale`, and the boundary is unchanged.** It is written by
 * `markSuccess` and `markFailure` from `new Date()` and by nothing else — there is no path on which a
 * failure site chooses its bytes, which is the property `error_message` lacks and the reason that column
 * stays out. `cost: "indexed"` is unchanged too: the index is `(name, rowid)`, `status` already required
 * the row itself to be fetched, and a second column off a row already in hand costs nothing.
 *
 * **`order by id desc`, never `started_at desc`, and that is what makes `cost: "indexed"` honest.** `id`
 * is `integer primary key autoincrement`, so it is the rowid, and SQLite keys `pithySecretsRotationsNameIdx`
 * as `(name, rowid)` — the newest row for a given name is one reverse seek into that index, with no sort
 * and no table scan, whatever the table holds. Ordering on `started_at` would make SQLite materialize
 * and sort every sentinel row ever written, a set that grows by one per pass forever; `HealthValueCost`
 * has no member for what that costs, so the key could not be declared at all. It is also the more
 * correct key: `started_at` is the journalled pass instant, so two rows can carry the same value and the
 * tie-break would be deciding the answer. Insertion order is the ledger's own order.
 *
 * **The `trigger` filter is defense in depth, and it is cheap.** `recordBaseline` writes a
 * `success`/`baseline` row under whatever name it is given, and nothing today reserves
 * {@link AT_REST_ROTATION_NAME} against a registry that declares it — see the note on the constant. A
 * baseline row is a first write and never a rotation, so excluding it here means establishing a secret
 * of that name cannot forge a `succeeded` on this key. The leading equality is still `name`, so the plan
 * is unchanged: the walk is a reverse scan of that one name's rows, and it stops at the first that is
 * not a baseline.
 *
 * The name is the sentinel and nothing else — there is no parameter, so this cannot become a rotation
 * history reader over stored (possibly tenant-bearing) names.
 */
export async function latestAtRestRotation(db: SecretsStatusDb): Promise<LatestAtRestRotation> {
  const row = await db
    .selectFrom("pithySecretsRotations")
    .select(["status", "completedAt"])
    .where("name", "=", AT_REST_ROTATION_NAME)
    .where("trigger", "in", ROTATION_TRIGGERS)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return { state: "none" };
  // The `catch` takes no binding, and the whole of this file's argument is why: a `ZodError` from this
  // parse carries the offending column value as its issue `input`, and this row's other columns are free
  // text written where a key was in scope. Nothing derived from the rejection may travel, and with
  // nothing bound there is nothing that could.
  try {
    const status = RotationStatus.parse(row.status);
    const completedAt = row.completedAt === null ? null : SQLiteDate.parse(row.completedAt);
    // **A `success` with no completion instant is not a row this capability wrote.** `markSuccess` sets
    // the status and the instant in one `set`, so the pair always lands together. Reporting such a row
    // `succeeded` would mean publishing a nominal value for a pass whose age cannot be established —
    // which is the reading `stale` exists to refuse — and reporting it `stale` would claim it closed
    // long ago, which nothing here knows. `unreadable` is the honest third answer and already means
    // exactly this: a row is there and it is not one this code produced.
    if (status === "success" && completedAt === null) return { state: "unreadable" };
    return { state: "readable", status, completedAt };
  } catch {
    return { state: "unreadable" };
  }
}

/**
 * How many rotation intervals a successful pass may age before it stops meaning anything.
 *
 * Two, and the arithmetic is the argument: at one interval a pass is merely *due*, and due-but-not-yet-run
 * is the ordinary state of every healthy project for as long as it takes the next cron tick to fire and
 * the next pass to finish. At two, a whole cadence has come and gone with nothing succeeding, which no
 * schedule that is running can produce. {@link AtRestRotationOutcome} argues it at length; `health.test.ts`
 * brackets it from both sides so the number is pinned by behavior rather than by this sentence.
 */
const STALE_AFTER_INTERVALS = 2;

/**
 * Whether a successful pass has aged past the cadence — *the* question a cron that stopped firing
 * answers wrongly under every other member.
 *
 * **Through {@link isRotationDue}, which is the cron's own definition of late.** The manager asks
 * `isRotationDue(config.lastRotatedAt, ROTATION_INTERVAL_DAYS, now)` on every tick to decide whether to
 * start a pass; this asks the same function, over the same interval, with the threshold widened by
 * {@link STALE_AFTER_INTERVALS}. Two answers to "is this late" is the disease #647 is about, so there is
 * one function and one interval, and the only thing this adds is how much lateness is worth reporting.
 *
 * **An interval the cron cannot use reports `stale`, and that is not a fallback — it is the correct
 * answer.** `isRotationDue` refuses a non-finite or non-positive interval, by design and for the reason
 * its own docblock gives. It refuses it *here* and it refuses it in `scheduled()`, where the refusal
 * throws before `AT_REST_ROTATION.create()` is ever reached — so a project whose interval does not parse
 * runs no rotation at all, on every tick, forever. A store whose rotation cannot start is exactly a store
 * whose last successful pass is the last one there will be. The `catch` takes no binding, like every
 * other catch on this path.
 */
function atRestPassStale(completedAt: Date, intervalDays: number, now: Date): boolean {
  try {
    return isRotationDue(completedAt.toISOString(), intervalDays * STALE_AFTER_INTERVALS, now);
  } catch {
    return true;
  }
}

/**
 * The ledger's last word, as the manifest's.
 *
 * **The return type is the closed union, and that is the structural half of "an outcome, never a
 * reason".** A column string does not compile here, so the rule does not depend on anybody remembering
 * it.
 *
 * **Staleness is applied last and only to `succeeded`.** Every other member already grades `attention`
 * and already tells an operator to go and look, so aging one of them would trade the more actionable
 * fact for the less actionable one — and aging `neverRun` would erase the difference between a store
 * that never rotated and one that rotated and then stopped. See {@link AtRestRotationOutcome} for the
 * whole precedence argument.
 */
export function atRestOutcome(latest: LatestAtRestRotation, intervalDays: number, now: Date): AtRestRotationOutcome {
  if (latest.state === "none") return "neverRun";
  if (latest.state === "unreadable") return "unreadable";
  const outcome = OUTCOME_OF_STATUS[latest.status];
  if (outcome !== "succeeded") return outcome;
  // `completedAt` is non-null on a `success` that came through `latestAtRestRotation`, which reports the
  // pair-without-its-partner as `unreadable`. A caller assembling the union by hand can still reach here,
  // and the answer for a success whose instant is unknown is the one that is not nominal: a `succeeded`
  // nothing can date is the exact reading this member exists to stop traveling.
  if (latest.completedAt === null) return "stale";
  return atRestPassStale(latest.completedAt, intervalDays, now) ? "stale" : "succeeded";
}

/**
 * Whether this Worker can open its own master key — the question the ledger cannot answer.
 *
 * Through {@link resolveEncryptionConfig} and never a second parse of the binding, because two readers
 * of one secret are two answers to one question: the probe must fail exactly when the rotation's own
 * pre-flight fails, and the only way to guarantee that is to call the same function.
 *
 * **The config is resolved and dropped.** Nothing binds it, nothing logs it, and the `catch` takes no
 * binding — so neither the key material nor the rejection's text is in scope anywhere on this path
 * (#386). What travels is one bit, rendered as one constant member.
 *
 * It costs one binding read rather than a query. In a deployed Worker that is the same Secrets Store
 * `.get()` every decryption in the process already makes; in dev it is a string off `.dev.vars`. Neither
 * is bounded by anything an adopter can grow, which is what lets this sit on a manifest read.
 */
async function masterKeyResolves(c: Context<PithyHonoEnv>): Promise<boolean> {
  // **Cast once, to the seam, rather than field by field.** Naming `D1Database` here would make this the
  // fifth file in the capability to import the Workers types directly, which `cli/src/ci/workersTypes.test.ts`
  // counts deliberately: every one of them is a file that cannot be read outside a Worker. `SecretsStoreEnv`
  // is the shape `resolveEncryptionConfig` already asks for, and `env/bindings.ts` is where it is declared.
  //
  // Cast rather than guarded: an absent binding is precisely the fault this probe exists to find, and
  // `resolveBinding` is the one place that decides what absent means.
  const env = c.env as unknown as SecretsStoreEnv;
  try {
    // **Through the reader that splits the two failures (#647 review).** `resolveEncryptionConfig` wraps a
    // Secrets Store blip and a master key that will not decode into one error, so a bare `catch` here
    // published `masterKeyUnresolvable` — the worst member this key has — on a transient fault. A key that
    // will not parse is a standing fact an operator must act on; a store that did not answer this second is
    // not, and saying the first when the second is true is how a health key stops being believed.
    await bindingConfigReader(env).read();
    return true;
  } catch (error) {
    // **Only an upstream failure is "unknown"; everything else really is unresolvable.** The first cut of
    // this had the split backwards — it treated a `SecretCryptoError` as the sole unresolvable case, which
    // reported a binding that is *not configured at all* as healthy, because `resolveBinding` raises
    // `secrets/not_found` for that. A key that will not decode and a key that is not there are both
    // standing facts an operator must act on. A store that did not answer this second is not, and that one
    // alone withholds the member rather than asserting it.
    return error instanceof UpstreamError;
  }
}

/**
 * How many of these entries are past their declared cadence — the one definition of "due", read by
 * the manifest count here and by the status route's own audit metadata.
 *
 * `overdue === true` and never merely truthy: the third state is null — nobody has said what late means
 * for that secret — and folding it into "not overdue" would be the same mistake as reporting a withheld
 * number as zero.
 *
 * **An unreadable entry is not counted, and the count is still a number (`#387`).** Before the per-row
 * guard, one malformed row threw out of `readSecretStatus` and this capability reported `unavailable` for
 * the whole manifest key — `#350` working exactly as designed, and still the wrong answer, because the
 * other secrets' freshness was knowable and went unreported. A secret whose row will not decode is now in
 * the same position as one that declares no cadence: nobody can say whether it is late, so it is not
 * asserted to be. That is a smaller lie than counting it either way, and a much smaller one than
 * withholding the number.
 */
export function dueForRotation(entries: readonly SecretStatusEntry[]): number {
  return entries.filter((entry) => entry.state === "readable" && entry.status.overdue === true).length;
}

/** How many declared secrets are past the cadence their registry entry declares. */
export async function countSecretsDueForRotation(
  db: SecretsStatusDb,
  registry: SecretRegistry,
  now?: Date,
): Promise<number> {
  return dueForRotation(await readSecretStatus(db, registry, now ? { now } : {}));
}

/**
 * How the last at-rest master-key rotation ended, for the manifest.
 *
 * **The master key is asked first and wins**, for the reason {@link AtRestRotationOutcome} argues at
 * length: a store that cannot resolve `SECRETS_ENCRYPTION_KEYS` never opens a ledger row, so the ledger
 * reports the last pass that *could* start — which is `succeeded` in the case this key was added for.
 *
 * **It answers with a value on every path, including the broken ones, and that is `#387`'s lesson one
 * level up.** `readCapabilityHealth` catches per *capability*, not per key, and `checked()` refuses a
 * summary that omits a declared key — so a throw here would take {@link SECRETS_DUE_FOR_ROTATION} down
 * with it and the whole entry would read `unavailable`. A ledger row that will not decode, or a master
 * key that will not resolve, is a fact that must cost its own key and nothing else.
 */
export async function readAtRestRotationOutcome(
  c: Context<PithyHonoEnv>,
  db: SecretsStatusDb,
  intervalDays: number,
  now: Date = new Date(),
): Promise<AtRestRotationOutcome> {
  if (!(await masterKeyResolves(c))) return "masterKeyUnresolvable";
  return atRestOutcome(await latestAtRestRotation(db), intervalDays, now);
}

/**
 * The capability's health summary, over the registry it actually composed.
 *
 * A thunk for the same reason the status routes take one: the set worth reporting is every capability's
 * combined registry, and that only exists after `compose` has run.
 *
 * **`rotationIntervalDays` is a value and not a thunk**, because unlike the registry it is settled before
 * anything composes: it is the adopter's own `secrets({ rotationIntervalDays })`, resolved once in
 * `capability.ts` and handed to this and to `SecretsCapability.rotationIntervalDays` from that one place.
 * It is the same number the manager Worker's `ROTATION_INTERVAL_DAYS` var carries — that var is declared
 * as this option's deployment form — and it is the only form of it an app Worker can see, since a Worker
 * cannot read another Worker's vars. A project that edits the var by hand without editing the option has
 * given itself two cadences, which is worth reporting against the declared one rather than against
 * nothing.
 */
export function secretsHealth(registry: () => SecretRegistry, rotationIntervalDays: number): CapabilityHealth {
  return defineCapabilityHealth({
    keys: [
      {
        key: SECRETS_DUE_FOR_ROTATION,
        kind: "count",
        states: null,
        // The scope the status read is already behind. A count is a smaller disclosure than the listing
        // it summarizes, but it is a disclosure of the same thing — which credentials are stale is a map
        // of where to push — so an adopter who withheld the listing withholds the number with it.
        scope: SECRETS_STATUS_READ_SCOPE,
        // Two statements, both index-served and both bounded by how many secrets the composed registry
        // *declares* — a number in the adopter's source — never by how many rows they hold.
        cost: "indexed",
        // Zero is the good answer, which `healthSummary.ts` names as this key's own example. Without the
        // bound a client holds a number and no way to grade it, `healthAttention()` can never list it,
        // and `standingOf` answers `unknowable` — correct, and not what this key means.
        nominal: { atMost: 0 },
        summary: "Secrets past the rotation cadence their registry entry declares.",
      },
      {
        key: LAST_AT_REST_ROTATION,
        kind: "state",
        // Spread from the producer's own union, so the declaration cannot drift from what is producible.
        // There is no second list to keep in step, which is what makes a `states` member and a returned
        // value the same set by construction rather than by review.
        states: [...AtRestRotationOutcome.options],
        // The same scope as the count, and for a stronger reason than symmetry. `secrets:rotate` is the
        // only other scope this capability's admin routes require, it gates a POST, and a read-only
        // dashboard would be told a value exists that it may never see — permanently. On merits this is
        // the weaker disclosure of the two already behind `secrets:status:read`: it names no secret, no
        // key version and no reason, where the listing names every credential the project holds and
        // which of them are overdue. `stale` widens it by one bit — whether the last pass is older than
        // twice the declared cadence — and that bit is strictly weaker than the rotation history this
        // same scope already serves, which carries every pass's instant outright.
        scope: SECRETS_STATUS_READ_SCOPE,
        // One binding read for the master key, then one reverse seek into `pithySecretsRotationsNameIdx`
        // on a constant this module owns, returning at most one row. Bounded by nothing an adopter can
        // grow — not by their secrets, not by their rows, not by how many rotations have run. See
        // `latestAtRestRotation` for why `order by id desc` is what keeps that true.
        cost: "indexed",
        nominal: [...AT_REST_NOMINAL],
        summary:
          "How the last at-rest master-key rotation ended, that none has run, or that the last one succeeded too long ago for the schedule to still be firing. A failure does not say whether the store is mid-rotation; read the rotation history.",
      },
    ],
    read: async (c) => {
      // One handle for both reads: the binding rule lives in `secretsStatusDatabase` and a second call
      // site is a second chance to get it wrong.
      const db = secretsStatusDatabase(c);
      const [due, lastRotation] = await Promise.all([
        countSecretsDueForRotation(db, registry()),
        readAtRestRotationOutcome(c, db, rotationIntervalDays),
      ]);
      return { [SECRETS_DUE_FOR_ROTATION]: due, [LAST_AT_REST_ROTATION]: lastRotation };
    },
  });
}
