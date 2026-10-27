// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields, type PurgeContext } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { testers } from "../capability";
import { testers_0001_cohorts } from "../migrations/0001_cohorts";
import { TESTERS_PURGE_SUMMARY, testersUserPurge } from "./contribution";

/**
 * Testers' part of a person's purge and export (#814), over real D1: the memberships held under the account's
 * address, and their events, are exported without the opt-in token, then erased — and nobody else's touched.
 */

const TABLES = [
  "pithy_testers_cohort_snapshots",
  "pithy_testers_events",
  "pithy_testers_members",
  "pithy_testers_cohorts",
];
const T = 1_700_000_000_000;

const purge = testersUserPurge();
const context = (address: string | null): PurgeContext => ({
  subject: { type: "user", id: "ada-id" },
  env: { DB: env.DB },
  address: async () => address,
});

async function exportOf(input: PurgeContext): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(input);
}

async function member(id: string, email: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO pithy_testers_members (id, cohort_id, email, name, opt_in_token, state, invited_at, last_invited_at, created_at, updated_at) VALUES (?, 'c1', ?, NULL, ?, 'invited', ?, ?, ?, ?)",
  )
    .bind(id, email, `token-${id}`, T, T, T, T)
    .run();
  await env.DB.prepare(
    "INSERT INTO pithy_testers_events (cohort_id, member_id, kind, actor, occurred_at, metadata, created_at) VALUES ('c1', ?, 'invited', 'developer', ?, '{}', ?)",
  )
    .bind(id, T, T)
    .run();
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await testers_0001_cohorts.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  await member("m-ada", "ada@example.test");
  await member("m-bob", "bob@example.test");
});

describe("the testers user purge", () => {
  test("testers() declares it for the user subject, with a summary and an export", () => {
    const declared = testers().purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(declared[0]?.summary).toBe(TESTERS_PURGE_SUMMARY);
    expect(typeof declared[0]?.export).toBe("function");
  });

  test("exports the memberships under the account's address and their events, without the opt-in token", async () => {
    const data = await exportOf(context("Ada@Example.test"));
    expect(data.memberships).toEqual([expect.objectContaining({ id: "m-ada", email: "ada@example.test" })]);
    expect(data.events).toEqual([expect.objectContaining({ memberId: "m-ada", kind: "invited" })]);
    expect(credentialFields(data)).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("token-m-ada");
  });

  test("with no address to read, there is nothing to export or erase", async () => {
    expect(await exportOf(context(null))).toEqual({ memberships: [], events: [] });
    await purge.erase(context(null));
    const left = await env.DB.prepare("SELECT count(*) AS n FROM pithy_testers_members").first<{ n: number }>();
    expect(left?.n).toBe(2);
  });

  test("erases them, and leaves everyone else's", async () => {
    await purge.erase(context("ada@example.test"));
    expect(await exportOf(context("ada@example.test"))).toEqual({ memberships: [], events: [] });
    const members = await env.DB.prepare("SELECT id FROM pithy_testers_members").all<{ id: string }>();
    expect(members.results.map((row) => row.id)).toEqual(["m-bob"]);
    const events = await env.DB.prepare("SELECT member_id FROM pithy_testers_events").all<{ member_id: string }>();
    expect(events.results.map((row) => row.member_id)).toEqual(["m-bob"]);
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada@example.test"));
    await expect(purge.erase(context("ada@example.test"))).resolves.toBeUndefined();
  });
});
