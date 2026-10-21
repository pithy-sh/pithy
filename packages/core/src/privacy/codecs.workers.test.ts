// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "../data/codecs";
import { createDatabase } from "../data/db";
import { phi, pii, secret } from "./classes";
import { classifyPrivacy } from "./classify";

/**
 * **A brand on a codec field is a type and nothing else** (#132, the codec open question).
 *
 * The data-layer rule is that every JS ↔ SQLite conversion goes through a codec, so a marked field is a marked
 * codec as often as a marked string. Each of the three codecs, marked, against a real D1: `encode` produces the
 * row shape, Kysely takes it unchanged, and `parse` hands back exactly what the unmarked schema would.
 */

const Profile = z
  .object({ phone: pii(z.string().describe("A phone number.")), city: z.string().describe("The city.") })
  .describe("A profile, stored as JSON.");

const Patient = z
  .object({
    id: z.number().describe("Auto-incrementing primary key."),
    email: pii(z.string().describe("Login email.")),
    smoker: phi(SQLiteBoolean).describe("Whether they smoke (0|1 in D1)."),
    bornAt: pii(SQLiteDate).describe("Date of birth (ms-epoch in D1)."),
    profile: sqliteJson(Profile).describe("The profile (JSON in D1)."),
    resetToken: secret(z.string()).nullable().describe("A password reset token, when one is outstanding."),
  })
  .describe("A patient row, every column a marked field.");
type Patient = z.output<typeof Patient>;

/** The same table, unmarked, for comparing what each parses to. */
const Plain = z
  .object({
    id: z.number().describe("id"),
    email: z.string().describe("email"),
    smoker: SQLiteBoolean.describe("smoker"),
    bornAt: SQLiteDate.describe("bornAt"),
    profile: sqliteJson(z.object({ phone: z.string(), city: z.string() })).describe("profile"),
    resetToken: z.string().nullable().describe("resetToken"),
  })
  .describe("The patient row, unmarked.");

function database() {
  return createDatabase(env.DB, { patients: Patient });
}

beforeEach(async () => {
  const db = database();
  await db.schema.dropTable("patients").ifExists().execute();
  await sql`
    create table patients (
      id integer primary key autoincrement,
      email text not null,
      smoker integer not null,
      born_at integer not null,
      profile text not null,
      reset_token text
    )
  `.execute(db);
});

describe("a marked codec field", () => {
  test("encodes to the SQLite row shape, which Kysely inserts unchanged, and parses back", async () => {
    const db = database();
    const bornAt = new Date(1_700_000_000_000);
    const value = Patient.parse({
      id: 0,
      email: "ada@example.com",
      smoker: false,
      bornAt,
      profile: { phone: "555-0100", city: "Oslo" },
      resetToken: null,
    });
    const { id: _id, ...row } = Patient.encode(value);
    expect(row).toEqual({
      email: "ada@example.com",
      smoker: 0,
      bornAt: 1_700_000_000_000,
      profile: JSON.stringify({ phone: "555-0100", city: "Oslo" }),
      resetToken: null,
    });

    await db.insertInto("patients").values(row).execute();
    const stored = await db.selectFrom("patients").selectAll().executeTakeFirstOrThrow();
    const read: Patient = Patient.parse(stored);
    expect(read).toEqual(Plain.parse(stored));
    expect(read.bornAt).toEqual(bornAt);
    expect(read.smoker).toBe(false);
    expect(read.profile).toEqual({ phone: "555-0100", city: "Oslo" });
  });

  test("still classifies, on the codec and on the JSON column a mark sits inside", () => {
    expect(classifyPrivacy(Patient)).toEqual([
      { path: "email", class: "pii" },
      { path: "smoker", class: "phi" },
      { path: "bornAt", class: "pii" },
      { path: "profile", class: "pii" },
      { path: "resetToken", class: "secret" },
    ]);
  });

  test("adds no column: the row a marked schema encodes has exactly the unmarked schema's keys", () => {
    const value = Patient.parse({
      id: 1,
      email: "a@b.c",
      smoker: true,
      bornAt: new Date(0),
      profile: { phone: "1", city: "x" },
      resetToken: "t",
    });
    expect(Object.keys(Patient.encode(value)).sort()).toEqual(Object.keys(Plain.encode(Plain.parse(value))).sort());
  });
});
