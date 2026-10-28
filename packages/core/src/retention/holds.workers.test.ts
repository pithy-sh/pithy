// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { controlPlaneDatabase } from "../controlPlane/data/tables";
import { controlplane_0005_holds } from "../controlPlane/migrations/0005_holds";
import { createDatabase } from "../data/db";
import { legalHolds, placeHold, releaseHold, standingHolds } from "./holds";
import { holdsUserPurge } from "./holdsPurge";

/**
 * The holds over real D1: what a user's access export carries of them, and the reads every purge asks, which throw
 * on any failure but a hold table that was never migrated.
 */

const AT = new Date("2026-10-01T09:00:00.000Z");
const COUNSEL = { subject: "usr_counsel" };

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_holds");
  await controlplane_0005_holds.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

describe("the access export of a user's holds", () => {
  async function exported(userId: string): Promise<Record<string, unknown>[]> {
    const contribution = holdsUserPurge();
    const document = await contribution.export?.({ subject: { type: "user", id: userId }, env: { DB: env.DB } });
    return (document?.holds ?? []) as Record<string, unknown>[];
  }

  test("carries the holds placed on the user and no other subject's, even one that shares the id", async () => {
    const db = controlPlaneDatabase(env.DB);
    const mine = await placeHold(db, {
      subjectType: "user",
      subjectId: "usr_1",
      reason: "Litigation, in counsel's words.",
      actor: COUNSEL,
      at: AT,
    });
    // An audit tenant and an organization named by the same id are other subjects, and stay out.
    await placeHold(db, { subjectType: "audit", subjectId: "usr_1", reason: "Trail.", actor: COUNSEL, at: AT });
    await placeHold(db, { subjectType: "organization", subjectId: "usr_1", reason: "Org.", actor: COUNSEL, at: AT });
    await placeHold(db, { subjectType: "user", subjectId: "usr_2", reason: "Other.", actor: COUNSEL, at: AT });

    const rows = await exported("usr_1");
    expect(rows.map((row) => row.id)).toEqual([mine.id]);
  });

  test("leaves out who placed and released it, and counsel's reasons", async () => {
    const db = controlPlaneDatabase(env.DB);
    const hold = await placeHold(db, {
      subjectType: "user",
      subjectId: "usr_1",
      reason: "Litigation.",
      actor: COUNSEL,
      at: AT,
    });
    const released = new Date("2026-10-05T09:00:00.000Z");
    await releaseHold(db, { id: hold.id, reason: "Settled.", actor: { subject: "usr_releaser" }, at: released });

    expect(await exported("usr_1")).toEqual([
      {
        id: hold.id,
        subjectType: "user",
        subjectId: "usr_1",
        placedAt: AT.toISOString(),
        state: "released",
        releasedAt: released.toISOString(),
      },
    ]);
  });
});

/** A binding whose every query fails with `message`, as an outage or a schema drift would. */
function failing(message: string): Record<string, unknown> {
  return {
    DB: {
      prepare: () => {
        throw new Error(message);
      },
      batch: async () => {
        throw new Error(message);
      },
    },
  };
}

describe("a hold read that fails", () => {
  test("throws on an outage, so the step retries rather than erasing past a hold it could not see", async () => {
    const outage = failing("D1_ERROR: Network connection lost.");
    await expect(legalHolds(outage).held("user", "usr_1")).rejects.toThrow(/Network connection lost/);
    await expect(standingHolds(outage)).rejects.toThrow(/Network connection lost/);
  });

  test("throws when a different table is missing: only the hold table's absence reads as nothing held", async () => {
    const drift = failing("D1_ERROR: no such table: pithy_controlplane_connections: SQLITE_ERROR");
    await expect(legalHolds(drift).held("user", "usr_1")).rejects.toThrow(/no such table/);
    await expect(standingHolds(drift)).rejects.toThrow(/no such table/);
  });

  test("throws on a missing column in the hold table, which is a partial migration and not an absent one", async () => {
    const partial = failing("D1_ERROR: no such column: subject_type: SQLITE_ERROR");
    await expect(legalHolds(partial).held("user", "usr_1")).rejects.toThrow(/no such column/);
    await expect(standingHolds(partial)).rejects.toThrow(/no such column/);
  });

  test("reads a database whose hold table was never created as holding nothing, and counts none", async () => {
    await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_holds");
    expect(await legalHolds({ DB: env.DB }).held("user", "usr_1")).toBe(false);
    expect(await standingHolds({ DB: env.DB })).toBe(0);
  });
});
