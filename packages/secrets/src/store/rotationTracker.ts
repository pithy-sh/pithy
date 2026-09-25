// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { RotationStatus, RotationTrigger } from "../data/secretRotations";
import { type SecretsTables, secretsTables } from "../data/tables";
import {
  type ClosedRotation,
  type OpenRotation,
  type RotationFailureCode,
  type RotationLedger,
  rotationClosure,
  rotationFailureText,
} from "../rotation/rotationLedger";
import type { ManagedEnvironment } from "../scope";

type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/**
 * Everything a rotation may journal into `metadata_snapshot` — a closed object of counts, and nothing else.
 *
 * **The column was typed `unknown`, and that is a write-side hole a read-side guard cannot close (`#647`).**
 * Four files refuse to *publish* this column: `admin/status.ts` omits it from every projection,
 * `admin/health.ts` selects one column so this one cannot be reached, and two suites assert on the whole
 * row. Every one of those is a promise about the reader. None of them stops a writer, and the writer is the
 * dangerous half here: the at-rest rotation's steps hold the key set, a read-back's answer and a decrypt
 * failure in scope, and `metadataSnapshot?: unknown` accepts each of them. "Let us journal what the
 * read-back saw" is one reasonable-looking commit, and it lands under a signature that has already agreed.
 *
 * So the parameter is this type, on D2's argument for the Secrets Store comment: a shape that **cannot
 * express** the unsafe value beats a rule that asks a future edit not to write one. Every member is a
 * number — there is no string leaf for a key, a version set, an entry name or an exception's text to arrive
 * through, and {@link RotationTracker.startRotation} parses it before it is serialized, so a JavaScript
 * caller holding a key gets a refusal rather than a column.
 *
 * `strictObject`, so an extra key is refused rather than dropped. Dropping would be safe and silent, and
 * silence is what let this column stay `unknown` for three releases.
 */
export const RotationSnapshot = z
  .strictObject({
    keySetSize: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "How many key versions the master-key set held when this pass opened. A count of the set and never the set itself — the number an incident review reads to see a key set that has been growing every cadence because retirement is blocked.",
      ),
  })
  .describe(
    "What a rotation pass may journal into `pithy_secrets_rotations.metadata_snapshot`: counts, and nothing a key, a key set or an exception could arrive through.",
  );
export type RotationSnapshot = z.infer<typeof RotationSnapshot>;

/**
 * The snapshot as the column holds it, or `null` when a caller journalled none.
 *
 * Parsed rather than trusted, because the type is absent at runtime and a JavaScript caller is not stopped
 * by one — the same reason `rotationFailureText` keeps a fallback under a closed union. The `catch` takes no
 * binding: a `ZodError` from this parse carries the offending value as its issue `input`, and the value this
 * refusal exists to reject is a key (`#386`). The `detail` names the shape and nothing that arrived.
 */
function journalledSnapshot(snapshot: RotationSnapshot | undefined): string | null {
  if (snapshot === undefined) return null;
  let checked: RotationSnapshot;
  try {
    checked = RotationSnapshot.parse(snapshot);
  } catch {
    throw new InternalError({
      message: "The secrets manager tried to journal a rotation snapshot it may not record.",
      action: "Nothing to run. The rotation snapshot holds counts only; report this with the manager's logs.",
      detail: "rotation snapshot: a member is missing, is not a whole number, or is not one this table records",
    });
  }
  return JSON.stringify(checked);
}

/**
 * Append-only tracker for rotation attempts, over the per-environment secrets D1's
 * `pithy_secrets_rotations` table. Ported from the CMS `RotationTracker`, scoped to one
 * environment (the per-env manager owns one store).
 *
 * `startRotation` opens an `in_progress` row and returns its id; `markSuccess`/`markFailure`
 * close it. `recordBaseline` seeds a `success`/`baseline` row when a rotatable secret is first
 * written, so the cadence check never flags a brand-new secret as overdue. `purgeHistory` clears
 * a deleted secret's rows so they don't linger.
 */
export class RotationTracker {
  readonly #db: SecretsDb;

  constructor(db: SecretsDb) {
    this.#db = db;
  }

  /** Build a tracker over a raw `SECRETS` D1 binding. */
  static fromD1(d1: D1Database): RotationTracker {
    return new RotationTracker(createDatabase(d1, secretsTables));
  }

  /**
   * Open an `in_progress` rotation row unconditionally, and return its id.
   *
   * The per-secret path: a value rotation of `auth-signing-key` and one of `stripe-webhook-secret` are
   * unrelated acts, and each is recorded whatever the other is doing. A whole-store at-rest pass is not —
   * it takes {@link claimRotation} instead, which is the same insert with the one condition that makes it
   * a lock.
   */
  async startRotation(
    name: string,
    trigger: RotationTrigger,
    rotatedBy: string,
    snapshot?: RotationSnapshot,
  ): Promise<number> {
    const inserted = await this.#db
      .insertInto("pithySecretsRotations")
      .values({
        name,
        startedAt: SQLiteDate.encode(new Date()),
        completedAt: null,
        status: "in_progress" satisfies RotationStatus,
        trigger,
        rotatedBy,
        errorMessage: null,
        metadataSnapshot: journalledSnapshot(snapshot),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  /**
   * Take the single-flight lock on `name` by opening its row, or answer `null` because somebody holds it.
   *
   * **The open row *is* the lock, and that is the fix (`#647`).** Two overlapping at-rest passes each
   * confirm their own read-backs, and the master-key entry takes a full-value replace with no conditional
   * write available — so the slower pass's promoted write deletes the key every row is by then sealed
   * under, its own read-back confirms the clobber, and the pass reports success. An undecryptable store,
   * signaled green. There is no recovery from it, which is why the guard against it may not have a hole.
   *
   * ## Why a read-then-insert was not one, and a wall clock made it worse
   *
   * This started as `liveRotation()` — a select for an open row younger than six hours — followed by an
   * insert. Two holes, and the destructive case walks through either:
   *
   *   - **The window.** A pass longer than six hours is a real shape here: a large store, a read-back poll
   *     that spends its minute of propagation tolerance on both gates, a Cloudflare outage the platform
   *     retries through. Its own row stops counting as live at hour six, and the next trigger starts a
   *     second pass over the same pointer. Making the window bigger moves the hole; it does not close it.
   *   - **The gap.** Between the select and the insert there is no barrier at all, so two triggers that
   *     read at the same instant both see nothing open and both insert.
   *
   * A condition on the insert has neither. SQLite runs one statement under an implicit transaction, so the
   * `not exists` is evaluated and the row is written without anything in between; two contenders serialize
   * and exactly one writes. `null` is the loser's answer, and it is a fact rather than an error — the
   * caller decides what declining means.
   *
   * ## And it does not expire, deliberately
   *
   * An evicted Workflow instance never reaches its own `mark-failure` step, so an abandoned row holds this
   * lock until somebody closes it. That is the cost, it was weighed, and it is the right way round: a held
   * lock stops rotation, and stopping rotation costs a store nothing it was not already surviving — every
   * secret still decrypts, `pithy secrets` still writes, and `lastAtRestRotation` reports `inProgress`,
   * which `standingOf` grades **attention** for as long as it lasts. An overlap costs the whole store,
   * permanently, and reports success. A timer that can release this lock is a timer a long pass walks
   * through, so there is none: a wedged row is cleared by an operator who has read the failure, on a row
   * they can see from the manifest.
   */
  async claimRotation(
    name: string,
    trigger: RotationTrigger,
    rotatedBy: string,
    snapshot?: RotationSnapshot,
    reclaimAs?: string,
  ): Promise<number | null> {
    const claimed = await this.#db
      .insertInto("pithySecretsRotations")
      .columns(["name", "startedAt", "status", "trigger", "rotatedBy", "metadataSnapshot"])
      .expression(
        this.#db
          .selectNoFrom((eb) => [
            eb.val(name).as("name"),
            eb.val(SQLiteDate.encode(new Date())).as("startedAt"),
            eb.val("in_progress" satisfies RotationStatus).as("status"),
            eb.val(trigger).as("trigger"),
            eb.val(rotatedBy).as("rotatedBy"),
            eb.val(journalledSnapshot(snapshot)).as("metadataSnapshot"),
          ])
          // The whole of the lock: the row is written only where this name holds no open one, in the same
          // statement that looks.
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("pithySecretsRotations")
                  .select("id")
                  .where("name", "=", name)
                  .where("status", "=", "in_progress"),
              ),
            ),
          ),
      )
      .returning("id")
      .executeTakeFirst();
    if (claimed) return claimed.id;

    // **A holder may retake its own claim, and without this the lock wedges itself (#647 review).**
    //
    // `step.do` is at-least-once for the step *body*, not for its effect. The insert above can commit and
    // the step result never reach the journal — an instance that dies in between, or a D1 fault ambiguous
    // enough that the engine retries a write that actually landed. The resume then re-executes this body,
    // finds the open row it wrote itself a moment earlier, and declines. Nothing releases the row, because
    // the whole argument for this lock is that it has no expiry a long pass could outlive. So one ambiguous
    // fault stopped at-rest rotation permanently, and the failure looked exactly like the healthy refusal.
    //
    // `rotatedBy` is what tells the two apart, and it has to be **the platform's own instance id** — the
    // whole soundness of this reclaim rests on one holder string naming exactly one pass. An open row under
    // this holder is this pass's own; an open row under another holder is somebody else's and still
    // declines. That is the column's documented meaning — "workflow instance id, operator id".
    //
    // **It was briefly something weaker, and that was a real hole (#647 review).** The at-rest pass first
    // composed its holder as `cron:at-rest-<pointer>-<UTC date>` — a recomputation of what the cron *would*
    // have used as an instance id. Two passes sharing a pointer and a day compose the identical string, so
    // a second instance created out of band (`wrangler workflows trigger`, the Workflows REST API) got a
    // fresh instance id, sailed past the platform's duplicate-id refusal, matched here, and was handed the
    // running pass's row. Two concurrent passes against one Secrets Store entry is precisely what the
    // paragraph above says has no recovery. A caller that cannot supply a per-pass identity gets the old
    // behavior, because its `rotatedBy` will not match a row it did not open.
    //
    // It does not weaken the lock. Two contenders still serialize on the insert, and the loser still gets
    // `null` unless it is literally the same pass resuming. A caller with no stable identity per attempt
    // gets the old behavior, because its `rotatedBy` will not match.
    // **The reclaim is opt-in, and a caller with no per-pass identity gets a pure lock.** `reclaimAs` is
    // supplied only where a holder string genuinely names one pass — production passes the Workflow
    // instance id. Absent it, there is nothing to match on that would not also match somebody else: the
    // ledger's `rotatedBy` default is a constant, so keying the reclaim on it would let *every* pass
    // reclaim *every* other one. That is the collision this reclaim exists to avoid, made universal.
    if (reclaimAs === undefined) return null;
    const mine = await this.#db
      .selectFrom("pithySecretsRotations")
      .select("id")
      .where("name", "=", name)
      .where("status", "=", "in_progress")
      .where("rotatedBy", "=", reclaimAs)
      .orderBy("id", "desc")
      .executeTakeFirst();
    return mine?.id ?? null;
  }

  /**
   * The id of a rotation of `name` that is open, or `null`.
   *
   * A read, and no longer a guard: {@link claimRotation} is what makes a pass single-flight, because a
   * select followed by an insert has a gap between them and this has no way to close it. What reads this
   * is a reporter — `pithy secrets verify` says a pass is in progress so an operator knows why the store
   * is mid-rotation.
   *
   * **There is no staleness ceiling here either, and the two answer one question.** A row that has sat
   * open for a week is a pass nothing closed, which is exactly what a reporter should say and exactly what
   * the claim should decline against; a ceiling would have this file call a row dead while the lock still
   * holds it, which is two answers to one question and the shape of the defect it replaced.
   */
  async liveRotation(name: string): Promise<number | null> {
    const row = await this.#db
      .selectFrom("pithySecretsRotations")
      // The id alone. `startedAt` was selected for the six-hour staleness window this reader used to apply,
      // and the window went with the lock it could not make sound — a column read by nothing is a column a
      // later edit reintroduces a rule around.
      .select("id")
      .where("name", "=", name)
      .where("status", "=", "in_progress")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? row.id : null;
  }

  /**
   * The most recent closed row for `name`, or `null` when there is none.
   *
   * Read by the cron to decide whether to start at all: a pass that could not confirm its write through
   * the binding must not be re-driven nightly (`rotationBackedOff`). `errorMessage` is the fixed sentence
   * a code wrote, and `rotationFailureCodeOf` reads the code back off it — so nothing here is free text
   * and nothing a value could have reached is compared.
   */
  async lastClosed(name: string): Promise<ClosedRotation | null> {
    const row = await this.#db
      .selectFrom("pithySecretsRotations")
      .select(["status", "completedAt", "errorMessage"])
      .where("name", "=", name)
      .where("completedAt", "is not", null)
      .orderBy("completedAt", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row || row.completedAt == null) return null;
    return {
      status: row.status,
      completedAt: new Date(row.completedAt as number),
      errorMessage: row.errorMessage ?? null,
    };
  }

  /** Close a rotation row as `success`. */
  async markSuccess(rotationId: number): Promise<void> {
    await this.#db
      .updateTable("pithySecretsRotations")
      .set({ status: "success" satisfies RotationStatus, completedAt: SQLiteDate.encode(new Date()) })
      .where("id", "=", rotationId)
      .execute();
  }

  /**
   * Close a rotation row as `failed`, under a code that names the failure.
   *
   * **It takes a code and not a sentence, and that is the whole of `#386`.** `error_message` is the one
   * column on this table a failure site writes, `rotationLedger.ts` states that its text is fixed and
   * chosen by a code, and the at-rest rotation path composed it from `cause.message` anyway — from a catch
   * reached by decryption, envelope decoding and config parsing, which are the paths whose exception text
   * can carry key material. Four files already refuse to publish this column; that refusal is defense in
   * depth and was never the invariant. The invariant is that there is nothing here to publish.
   *
   * A comment asking for a code would have been the same comment that was already there. So the signature
   * asks: {@link RotationFailureCode} is a closed union, `rotationFailureText` maps it here rather than at
   * the call site, and a caller holding an exception has nowhere to put it. The exception is still raised,
   * and its context still travels in a `PithyError`'s `detail`, which the HTTP codec strips.
   */
  async markFailure(rotationId: number, code: RotationFailureCode): Promise<void> {
    await this.#db
      .updateTable("pithySecretsRotations")
      .set({
        status: "failed" satisfies RotationStatus,
        completedAt: SQLiteDate.encode(new Date()),
        errorMessage: rotationFailureText(code),
      })
      .where("id", "=", rotationId)
      .execute();
  }

  /**
   * Seed a `success`/`baseline` row so a brand-new rotatable secret is not flagged overdue.
   *
   * **A first write, and it stays that.** `trigger: "baseline"` is what distinguishes establishing a value
   * from replacing one — a rotation writes `manual` or `cron` through {@link trackerRotationLedger} and
   * carries an actor. Widening this to cover updates would let a typo fix advance a freshness clock
   * nobody rotated; see `../rotation/rotationLedger.ts`.
   */
  async recordBaseline(name: string): Promise<void> {
    const now = SQLiteDate.encode(new Date());
    await this.#db
      .insertInto("pithySecretsRotations")
      .values({
        name,
        startedAt: now,
        completedAt: now,
        status: "success" satisfies RotationStatus,
        trigger: "baseline" satisfies RotationTrigger,
        rotatedBy: "baseline",
        errorMessage: null,
        metadataSnapshot: null,
      })
      .execute();
  }

  /** The most recent successful completion for a name, or `null` if it has never succeeded. */
  async getLatestSuccess(name: string): Promise<Date | null> {
    const row = await this.#db
      .selectFrom("pithySecretsRotations")
      .select("completedAt")
      .where("name", "=", name)
      .where("status", "=", "success")
      .where("completedAt", "is not", null)
      .orderBy("completedAt", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row || row.completedAt == null) return null;
    return new Date(row.completedAt as number);
  }

  /** Remove all rotation rows for a secret (called on delete). Returns the count removed. */
  async purgeHistory(name: string): Promise<number> {
    const before = await this.#db
      .selectFrom("pithySecretsRotations")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("name", "=", name)
      .executeTakeFirst();
    await this.#db.deleteFrom("pithySecretsRotations").where("name", "=", name).execute();
    return Number(before?.count ?? 0);
  }
}

/** What {@link trackerRotationLedger} needs beyond the tracker: which environment it is, and who is asking. */
export interface TrackerRotationLedgerOptions {
  /** The environment this D1 belongs to. Decides how the row closes — see `rotationClosure`. */
  environment: ManagedEnvironment;
  /** What caused the rotation: an operator (`manual`) or the manager's own schedule (`cron`). Never `baseline`. */
  trigger: Exclude<RotationTrigger, "baseline">;
  /** Who asked. A verified control-plane subject in a Worker, a workflow instance id for a scheduled run. */
  rotatedBy: string;
}

/**
 * The in-Worker {@link RotationLedger}: the rotation table this process already holds a handle to.
 *
 * The direct half of the seam. Anything running *inside* an environment — a control-plane rotate route, the
 * manager's own cron — records through this; a process outside one records the identical rows through
 * `../cli/rotationLedger.ts`, over a dispatch. Both compose the closing verdict with `rotationClosure` and
 * the failure sentence with `rotationFailureText`, which is what stops the two paths from disagreeing about
 * whether a rotation happened (`#379`).
 */
export function trackerRotationLedger(tracker: RotationTracker, options: TrackerRotationLedgerOptions): RotationLedger {
  return {
    async open(name: string): Promise<OpenRotation> {
      const rotationId = await tracker.startRotation(name, options.trigger, options.rotatedBy);
      return {
        async close(outcome): Promise<void> {
          const closure = rotationClosure(outcome, options.environment);
          if (closure.status === "success") await tracker.markSuccess(rotationId);
          // The reason, not its sentence. Every reason is a `RotationFailureCode`, and the tracker renders
          // it — one place composes the text, on both sides of the seam (`#386`).
          else await tracker.markFailure(rotationId, closure.reason);
        },
      };
    },
  };
}
