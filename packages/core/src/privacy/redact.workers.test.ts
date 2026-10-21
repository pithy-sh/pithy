// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "../data/codecs";
import { createDatabase } from "../data/db";
import { phi, pii } from "./classes";
import { classifyPrivacy } from "./classify";
import { redact } from "./redact";
import type { Redacted } from "./types";

/**
 * **A row read from a real D1, and the values copied out of it, redact exactly** (#132, contract items 5 and 7).
 *
 * The row carries the kit's three codecs, and its JSON column holds arrays and records of marked fields. The values a
 * handler builds from it — a plain object, a list, a map keyed by id, a tuple, a set — are described by supported
 * schemas, and each comes back with every marked field masked and every other one as `parse` returned it.
 */

const Contact = z
  .object({
    kind: z.enum(["email", "phone"]).describe("How to reach them."),
    value: pii(z.string().describe("The address or number.")),
    verified: z.boolean().describe("Whether it was confirmed."),
  })
  .describe("One way to reach a patient.");

const Note = z
  .object({ text: phi(z.string().describe("What was recorded.")), author: z.string().describe("Who wrote it.") })
  .describe("A clinical note.");

const Chart = z
  .object({
    contacts: z.array(Contact).describe("Every contact, in order."),
    notes: z.record(z.string(), Note).describe("Notes by visit id."),
    allergies: z.array(z.string()).describe("Known allergies, not marked."),
  })
  .describe("The chart, stored as JSON.");

const Visit = z
  .object({
    id: z.number().describe("Auto-incrementing primary key."),
    patientId: z.string().describe("The patient's stable id."),
    email: pii(z.string().describe("The patient's login email.")),
    seenAt: SQLiteDate.describe("When the visit happened."),
    bornAt: pii(SQLiteDate).describe("Date of birth."),
    urgent: SQLiteBoolean.describe("Whether it was urgent."),
    chart: sqliteJson(Chart).describe("The chart (JSON in D1)."),
  })
  .describe("A visit row.");

/** What a handler builds from the row: every container the contract names, each described by a supported schema. */
const View = z
  .object({
    visit: Visit.describe("The row itself."),
    contacts: z.array(Contact).describe("The row's contacts, copied out."),
    byPatient: z.map(z.string(), Visit).describe("The row, keyed by patient."),
    notes: z.map(z.string(), Note).describe("The chart's notes, as a map."),
    first: z.tuple([z.number(), Contact]).describe("The id and the first contact."),
    emails: z.set(pii(z.string())).describe("Every contact value."),
  })
  .describe("A handler's view of one visit.");

function database() {
  return createDatabase(env.DB, { visits: Visit });
}

beforeEach(async () => {
  const db = database();
  await db.schema.dropTable("visits").ifExists().execute();
  await sql`
    create table visits (
      id integer primary key autoincrement,
      patient_id text not null,
      email text not null,
      seen_at integer not null,
      born_at integer not null,
      urgent integer not null,
      chart text not null
    )
  `.execute(db);
});

describe("redact over a row read from D1", () => {
  test("masks every marked field of the row and of every value copied out of it, and keeps the rest", async () => {
    const db = database();
    const { id: _id, ...row } = Visit.encode(
      Visit.parse({
        id: 0,
        patientId: "p_1",
        email: "ada@example.com",
        seenAt: new Date(1_700_000_000_000),
        bornAt: new Date(0),
        urgent: true,
        chart: {
          contacts: [
            { kind: "email", value: "ada@example.com", verified: true },
            { kind: "phone", value: "555-0100", verified: false },
          ],
          notes: { v_1: { text: "asthma", author: "dr_k" } },
          allergies: ["penicillin"],
        },
      }),
    );
    await db.insertInto("visits").values(row).execute();
    const visit = Visit.parse(await db.selectFrom("visits").selectAll().executeTakeFirstOrThrow());

    const masked = {
      id: 1,
      patientId: "p_1",
      email: "[pii]",
      seenAt: new Date(1_700_000_000_000),
      bornAt: "[pii]",
      urgent: true,
      chart: {
        contacts: [
          { kind: "email", value: "[pii]", verified: true },
          { kind: "phone", value: "[pii]", verified: false },
        ],
        notes: { v_1: { text: "[phi]", author: "dr_k" } },
        allergies: ["penicillin"],
      },
    };
    expect(redact(Visit, visit)).toEqual(masked);

    const view = View.parse({
      visit,
      contacts: visit.chart.contacts,
      byPatient: new Map([[visit.patientId, visit]]),
      notes: new Map(Object.entries(visit.chart.notes)),
      first: [visit.id, visit.chart.contacts[0]],
      emails: new Set(visit.chart.contacts.map((contact) => contact.value)),
    });
    const out: Redacted<typeof View> = redact(View, view);
    expect(out).toEqual({
      visit: masked,
      contacts: masked.chart.contacts,
      byPatient: new Map([["p_1", masked]]),
      notes: new Map([["v_1", { text: "[phi]", author: "dr_k" }]]),
      first: [1, masked.chart.contacts[0]],
      emails: new Set(["[pii]", "[pii] #2"]),
    });
    expect(JSON.stringify([...out.byPatient.values(), [...out.emails]])).not.toMatch(/ada@|555-0100|asthma/);
    expect(classifyPrivacy(View).map((field) => `${field.path} ${field.class}`)).toEqual([
      "visit.email pii",
      "visit.bornAt pii",
      "visit.chart.contacts[].value pii",
      "visit.chart.notes.*.text phi",
      "contacts[].value pii",
      "byPatient.*.email pii",
      "byPatient.*.bornAt pii",
      "byPatient.*.chart.contacts[].value pii",
      "byPatient.*.chart.notes.*.text phi",
      "notes.*.text phi",
      "first[1].value pii",
      "emails[] pii",
    ]);
  });
});
