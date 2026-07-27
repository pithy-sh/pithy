import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { rating_0001_rating } from "./0001_rating";

// A bare Kysely over the D1 binding — the migration operates on raw DDL, so no schema is needed.
function db(): Kysely<unknown> {
  return createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
}

/** Everything 0001 creates, as it appears in SQLite's catalog. */
async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_rating_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_rating_ratings");
});

describe("rating_0001_rating", () => {
  test("up creates the ratings table and its two indexes", async () => {
    await rating_0001_rating.up(db());
    expect(await catalog()).toEqual([
      "pithy_rating_ratings",
      "pithy_rating_ratings_player_idx",
      "pithy_rating_ratings_skill_idx",
    ]);
  });

  test("down is the exact inverse — nothing of the migration survives", async () => {
    await rating_0001_rating.up(db());
    await rating_0001_rating.down?.(db());
    expect(await catalog()).toEqual([]);
  });

  test("up then down then up again is clean (rollback is re-runnable)", async () => {
    await rating_0001_rating.up(db());
    await rating_0001_rating.down?.(db());
    await rating_0001_rating.up(db());
    expect(await catalog()).toContain("pithy_rating_ratings");
  });
});
