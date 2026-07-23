import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { multiplayer_0001_results } from "./0001_results";

// A bare Kysely over the D1 binding — the migration operates on raw DDL, so no schema is needed.
function db(): Kysely<unknown> {
  return createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
}

/** The tables/indexes 0001 creates, as they appear in SQLite's catalog. */
async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_multiplayer_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  for (const t of ["pithy_multiplayer_results"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
});

describe("multiplayer_0001_results", () => {
  test("up creates the results table and its indexes", async () => {
    await multiplayer_0001_results.up(db());
    expect(await catalog()).toEqual([
      "pithy_multiplayer_results",
      "pithy_multiplayer_results_game_idx",
      "pithy_multiplayer_results_winner_idx",
    ]);
  });

  test("down is the exact inverse — nothing of the migration survives", async () => {
    await multiplayer_0001_results.up(db());
    await multiplayer_0001_results.down?.(db());
    expect(await catalog()).toEqual([]);
  });

  test("up then down then up again is clean (rollback is re-runnable)", async () => {
    await multiplayer_0001_results.up(db());
    await multiplayer_0001_results.down?.(db());
    await multiplayer_0001_results.up(db());
    expect(await catalog()).toContain("pithy_multiplayer_results");
  });
});
