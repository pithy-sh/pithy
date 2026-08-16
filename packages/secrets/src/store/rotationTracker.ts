// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { RotationStatus, RotationTrigger } from "../data/secretRotations";
import { type SecretsTables, secretsTables } from "../data/tables";
import {
  type OpenRotation,
  type RotationFailureCode,
  type RotationLedger,
  rotationClosure,
  rotationFailureText,
} from "../rotation/rotationLedger";
import type { ManagedEnvironment } from "../scope";

type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

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

  /** Open an `in_progress` rotation row and return its id. */
  async startRotation(
    name: string,
    trigger: RotationTrigger,
    rotatedBy: string,
    metadataSnapshot?: unknown,
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
        metadataSnapshot: metadataSnapshot === undefined ? null : JSON.stringify(metadataSnapshot),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return inserted.id;
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
   * can carry key material. Four files already refuse to publish this column; that refusal is defence in
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
