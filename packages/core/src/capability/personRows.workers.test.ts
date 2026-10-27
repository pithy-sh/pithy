// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteDate } from "../data/codecs";
import { personRowsExport, personRowsPurge } from "./personRows";

/** The shared person-rows contribution (#814), over real D1. */

const Friend = z
  .object({
    id: z.number().describe("Primary key."),
    userA: z.string().describe("One side."),
    userB: z.string().describe("The other side."),
    secretNote: z.string().describe("A column the export leaves out."),
    createdAt: SQLiteDate.describe("When."),
  })
  .describe("A friendship.");

const Score = z
  .object({ id: z.number().describe("Primary key."), userId: z.string().describe("Whose.") })
  .describe("A score.");

const purge = personRowsPurge({
  capability: "games",
  summary: "Deletes the user's friendships and scores.",
  tables: [
    {
      table: "friends",
      schema: Friend,
      columns: ["userA", "userB"],
      as: "friends",
      orderBy: "id",
      omit: ["secretNote"],
    },
    { table: "scores", schema: Score, columns: ["userId"], as: "scores", orderBy: "id" },
  ],
});
const context = (id: string, bindings: Record<string, unknown> = { DB: env.DB }) => ({
  subject: { type: "user" as const, id },
  env: bindings,
});

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS friends");
  await env.DB.exec("DROP TABLE IF EXISTS scores");
  await env.DB.exec(
    "CREATE TABLE friends (id INTEGER PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, secret_note TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  await env.DB.exec("CREATE TABLE scores (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL)");
  await env.DB.exec(
    "INSERT INTO friends VALUES (1, 'ada', 'bob', 's1', 1700000000000), (2, 'cy', 'ada', 's2', 1700000000000), (3, 'bob', 'cy', 's3', 1700000000000)",
  );
  await env.DB.exec("INSERT INTO scores VALUES (1, 'ada'), (2, 'bob')");
});

describe("personRowsPurge", () => {
  test("exports every row naming the person in any of its columns, decoded, without the omitted columns", async () => {
    expect(await purge.export?.(context("ada"))).toEqual({
      friends: [
        { id: 1, userA: "ada", userB: "bob", createdAt: "2023-11-14T22:13:20.000Z" },
        { id: 2, userA: "cy", userB: "ada", createdAt: "2023-11-14T22:13:20.000Z" },
      ],
      scores: [{ id: 1, userId: "ada" }],
    });
  });

  test("erases them, and leaves every row that does not name the person", async () => {
    await purge.erase(context("ada"));
    expect(await purge.export?.(context("ada"))).toEqual({ friends: [], scores: [] });
    const left = await env.DB.prepare("SELECT id FROM friends").all<{ id: number }>();
    expect(left.results.map((row) => row.id)).toEqual([3]);
    expect((await purge.export?.(context("bob")))?.scores).toEqual([{ id: 2, userId: "bob" }]);
  });

  test("a redact sees the whole decoded row, before omit drops a column, and its result is what is exported", async () => {
    const exported = personRowsExport({
      capability: "games",
      tables: [
        {
          table: "friends",
          schema: Friend,
          columns: ["userA", "userB"],
          as: "friends",
          orderBy: "id",
          omit: ["secretNote"],
          redact: (row) => (row.secretNote === "s1" ? { ...row, userB: null } : row),
        },
      ],
    });
    expect(await exported(context("ada"))).toEqual({
      friends: [
        { id: 1, userA: "ada", userB: null, createdAt: "2023-11-14T22:13:20.000Z" },
        { id: 2, userA: "cy", userB: "ada", createdAt: "2023-11-14T22:13:20.000Z" },
      ],
    });
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada"));
    await expect(purge.erase(context("ada"))).resolves.toBeUndefined();
  });

  test("a match narrows a table to the rows that also hold it — a person's, where one column names people and more", async () => {
    await env.DB.exec("DROP TABLE IF EXISTS grants");
    await env.DB.exec(
      "CREATE TABLE grants (id INTEGER PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL)",
    );
    await env.DB.exec("INSERT INTO grants VALUES (1, 'user', 'ada'), (2, 'organization', 'ada')");
    const Grant = z
      .object({
        id: z.number().describe("Primary key."),
        subjectType: z.string().describe("Whose kind."),
        subjectId: z.string().describe("Whose."),
      })
      .describe("A grant.");
    const read = personRowsExport({
      capability: "billing",
      tables: [
        { table: "grants", schema: Grant, columns: ["subjectId"], match: { subjectType: "user" }, as: "grants" },
      ],
    });
    expect(await read(context("ada"))).toEqual({ grants: [{ id: 1, subjectType: "user", subjectId: "ada" }] });
  });

  test("a Worker without the binding is refused, naming the capability", async () => {
    await expect(purge.erase(context("ada", {}))).rejects.toThrow(/games/);
  });
});
