// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { ownedNames } from "./owned";

/** A migration that makes a table, an index on it and a trigger on it. */
const notes: Migration = {
  up: async (db) => {
    await sql`CREATE TABLE notes (id integer primary key, body text)`.execute(db);
    await sql`CREATE INDEX notes_body ON notes(body)`.execute(db);
    await sql`CREATE TRIGGER notes_touch AFTER INSERT ON notes BEGIN SELECT 1; END`.execute(db);
  },
  down: async () => {},
};

/** A migration the database never applied. */
const later: Migration = {
  up: async (db) => {
    await sql`CREATE TABLE later (id integer)`.execute(db);
  },
  down: async () => {},
};

describe("ownedNames", () => {
  test("names every table, index and trigger the applied migrations make, and nothing else", async () => {
    const owned = await ownedNames({ getMigrations: async () => ({ "0001_notes": notes, "0002_later": later }) }, [
      "0001_notes",
    ]);
    expect(owned).toContain("notes");
    expect(owned).toContain("notes_body");
    expect(owned).toContain("notes_touch");
    // Not applied by the database, so not run: what it would make is not owned here.
    expect(owned).not.toContain("later");
  });

  test("an applied key this CLI no longer has is skipped, not run and not refused", async () => {
    const owned = await ownedNames({ getMigrations: async () => ({ "0001_notes": notes }) }, [
      "0001_notes",
      "0000_gone",
    ]);
    expect(owned).toContain("notes");
  });
});
