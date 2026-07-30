// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { RotationStatus, RotationTrigger } from "../data/secretRotations";
import { type SecretsTables, secretsTables } from "../data/tables";

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

  /** Close a rotation row as `failed`, persisting a redacted reason. */
  async markFailure(rotationId: number, errorMessage: string): Promise<void> {
    await this.#db
      .updateTable("pithySecretsRotations")
      .set({ status: "failed" satisfies RotationStatus, completedAt: SQLiteDate.encode(new Date()), errorMessage })
      .where("id", "=", rotationId)
      .execute();
  }

  /** Seed a `success`/`baseline` row so a brand-new rotatable secret is not flagged overdue. */
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
