// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { rating } from "../capability";
import { rating_0001_rating } from "../migrations/0001_rating";
import { RATING_PURGE_SUMMARY, ratingUserPurge } from "./contribution";

/**
 * Rating's part of a person's purge and export (#814), over real D1: rows present, exported, purged,
 * gone — and nobody else's touched.
 */

const context = (id: string) => ({ subject: { type: "user" as const, id }, env: { DB: env.DB } });
/** The contribution's export, which every kit contribution declares. */
async function exportOf(input: ReturnType<typeof context>): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(input);
}

const purge = ratingUserPurge();

async function count(table: string, column: string, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_rating_ratings");
  await rating_0001_rating.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  await env.DB.exec(
    "INSERT INTO pithy_rating_ratings (pool, user_id, algorithm, state, skill, xp, games, updated_at) VALUES ('demo', 'ada', 'elo', '{\"rating\":1520}', 1520, 40, 3, 1700000000000), ('ranked', 'ada', 'elo', '{\"rating\":1400}', 1400, 0, 1, 1700000000000), ('demo', 'bob', 'elo', '{\"rating\":1500}', 1500, 0, 1, 1700000000000)",
  );
});

describe("the rating user purge", () => {
  test("rating() declares it for the user subject, with a summary and an export", () => {
    const declared = rating({ games: [{ key: "ranked", algorithm: "elo" }] }).purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(declared[0]?.summary).toBe(RATING_PURGE_SUMMARY);
    expect(typeof declared[0]?.export).toBe("function");
  });

  test("exports the person's rows, and no credential", async () => {
    const data = await exportOf(context("ada"));
    expect(data.ratings).toEqual([
      expect.objectContaining({ pool: "demo", userId: "ada", skill: 1520, state: { rating: 1520 } }),
      expect.objectContaining({ pool: "ranked", userId: "ada", skill: 1400 }),
    ]);
    expect(credentialFields(data)).toEqual([]);
  });

  test("erases them, and leaves everyone else's", async () => {
    await purge.erase(context("ada"));
    expect(await count("pithy_rating_ratings", "user_id", "ada")).toBe(0);
    expect(await exportOf(context("ada"))).toEqual({ ratings: [] });
    expect(JSON.stringify(await exportOf(context("bob")))).toContain("bob");
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada"));
    await expect(purge.erase(context("ada"))).resolves.toBeUndefined();
  });
});
