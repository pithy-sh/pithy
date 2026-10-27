// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { multiplayer_0001_results } from "./0001_results";
import { multiplayer_0002_session_index } from "./0002_session_index";

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
  for (const t of ["pithy_multiplayer_results", "pithy_multiplayer_sessions", "pithy_multiplayer_void_keys"]) {
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

describe("multiplayer_0002_session_index", () => {
  /** The columns SQLite reports for the results table. */
  async function resultColumns(): Promise<string[]> {
    const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('pithy_multiplayer_results')").all<{
      name: string;
    }>();
    return results.map((r) => r.name);
  }

  test("up creates the session index, the void columns on the results, and the spent void keys", async () => {
    await multiplayer_0001_results.up(db());
    await multiplayer_0002_session_index.up(db());
    expect(await catalog()).toEqual([
      "pithy_multiplayer_results",
      "pithy_multiplayer_results_game_idx",
      "pithy_multiplayer_results_void_key_idx",
      "pithy_multiplayer_results_winner_idx",
      "pithy_multiplayer_sessions",
      "pithy_multiplayer_sessions_game_idx",
      "pithy_multiplayer_void_keys",
    ]);
    expect(await resultColumns()).toEqual(expect.arrayContaining(["voided_at", "void_key", "void_consumers"]));
  });

  test("one void key cannot void two results, and results nobody voided never collide", async () => {
    await multiplayer_0001_results.up(db());
    await multiplayer_0002_session_index.up(db());
    const insert = (session: string, key: string | null) =>
      env.DB.prepare(
        "INSERT INTO pithy_multiplayer_results (session_id, game_key, status, players, draw, created_at, resolved_at, void_key) VALUES (?, 'g', 'resolved', '[]', 0, 1, 1, ?)",
      )
        .bind(session, key)
        .run();
    await insert("a", null);
    await insert("b", null);
    await insert("c", "k1");
    await expect(insert("d", "k1")).rejects.toThrow(/UNIQUE/);
    const spend = (key: string, session: string) =>
      env.DB.prepare("INSERT INTO pithy_multiplayer_void_keys (void_key, session_id, spent_at) VALUES (?, ?, 1)")
        .bind(key, session)
        .run();
    await spend("k1", "c");
    await expect(spend("k1", "c")).rejects.toThrow(/UNIQUE/);
  });

  test("down is the exact inverse of up, leaving 0001's schema", async () => {
    await multiplayer_0001_results.up(db());
    const before = await resultColumns();
    await multiplayer_0002_session_index.up(db());
    await multiplayer_0002_session_index.down?.(db());
    expect(await catalog()).toEqual([
      "pithy_multiplayer_results",
      "pithy_multiplayer_results_game_idx",
      "pithy_multiplayer_results_winner_idx",
    ]);
    expect(await resultColumns()).toEqual(before);
    await multiplayer_0002_session_index.up(db());
    expect(await catalog()).toContain("pithy_multiplayer_sessions");
  });
});
