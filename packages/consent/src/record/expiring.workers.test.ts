// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { type ConsentPurpose, ConsentPurpose as ConsentPurposeSchema } from "@pithy-sh/core/src/consent/purpose";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { CONSENT_MIGRATION_ORDER } from "../capability";
import { consentDatabase } from "../data/tables";
import { documentHash } from "../evidence/evidence";
import { consent_0001_init } from "../migrations/0001_init";
import { consentCounts } from "./counts";
import { type ExpiringQuery, expiringGrants } from "./expiring";
import { consentStore } from "./store";

/**
 * The signed grants expiring or expired, on real D1: each subject's latest grant per purpose, named the way the
 * counts name it, soonest first, and paged.
 */

const T0 = new Date("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;
const DOCUMENT = "I authorize the clinic to keep my health record.";

const purpose = (id: string): ConsentPurpose =>
  ConsentPurposeSchema.parse({ id, summary: "Keep my record.", noticeVersion: 1, minimumMethod: "click" });

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "consent",
      order: CONSENT_MIGRATION_ORDER,
      migrations: { "0001_init": consent_0001_init },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
}

let clock = T0;
let ids = 0;

function store() {
  return consentStore({
    db: consentDatabase(env.DB),
    keys: env.PITHY_FIELD_KEYS,
    bucket: env.CONSENT_EVIDENCE,
    purposes: new Map([
      ["clinic.records", purpose("clinic.records")],
      ["clinic.research", purpose("clinic.research")],
    ]),
    visitorWindowMs: 30 * DAY,
    now: () => clock,
    newId: () => {
      ids += 1;
      return `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`;
    },
  });
}

const ada = { kind: "account" as const, id: "user-ada" };
const bob = { kind: "account" as const, id: "user-bob" };
const cy = { kind: "account" as const, id: "user-cy" };
const visitor = { kind: "visitor" as const, id: "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13" };

const signed = (expiresInDays: number | null, purposeId = "clinic.records") => ({
  purpose: purposeId,
  noticeVersion: 1,
  method: "typed" as const,
  surface: "intake",
  document: DOCUMENT,
  typedName: "Ada Lovelace",
  representative: { name: "Byron", relationship: "parent" },
  ...(expiresInDays === null ? {} : { expiresAt: new Date(T0.getTime() + expiresInDays * DAY).toISOString() }),
});
const withdrawal = { purpose: "clinic.records", method: "click" as const, surface: "settings" };

function query(overrides: Partial<ExpiringQuery> = {}): ExpiringQuery {
  return {
    purposes: ["clinic.records", "clinic.research"],
    now: clock,
    horizon: new Date(clock.getTime() + 30 * DAY),
    ...overrides,
  };
}

const list = (overrides: Partial<ExpiringQuery> = {}) => expiringGrants(consentDatabase(env.DB), query(overrides));

beforeEach(async () => {
  clock = T0;
  ids = 0;
  for (const table of [
    "pithy_consent_records",
    "pithy_consent_documents",
    "pithy_consent_merges",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await runMigrations(env.DB, provider());
});

describe("expiringGrants", () => {
  test("lists each expired or soon-expiring grant, soonest first, with its facts and nothing typed", async () => {
    const s = store();
    await s.grant(ada, signed(20));
    await s.grant(bob, signed(2));
    await s.grant(cy, signed(60));
    clock = new Date(T0.getTime() + 5 * DAY);

    const page = await list();
    expect(page.nextCursor).toBeNull();
    expect(page.grants).toEqual([
      {
        recordId: "00000000-0000-4000-8000-000000000002",
        subject: bob,
        purpose: "clinic.records",
        noticeVersion: 1,
        method: "typed",
        expiresAt: new Date(T0.getTime() + 2 * DAY),
        expired: true,
        documentHash: await documentHash(DOCUMENT),
      },
      {
        recordId: "00000000-0000-4000-8000-000000000001",
        subject: ada,
        purpose: "clinic.records",
        noticeVersion: 1,
        method: "typed",
        expiresAt: new Date(T0.getTime() + 20 * DAY),
        expired: false,
        documentHash: await documentHash(DOCUMENT),
      },
    ]);
  });

  test("a grant expiring exactly at the horizon is in; one past it is out", async () => {
    const s = store();
    await s.grant(ada, signed(30));
    await s.grant(bob, signed(31));
    expect((await list()).grants.map((grant) => grant.subject)).toEqual([ada]);
  });

  test("an expiry at exactly now has passed, as hasConsent reads it", async () => {
    const s = store();
    await s.grant(ada, signed(1));
    clock = new Date(T0.getTime() + DAY);
    expect(await s.hasConsent(ada, "clinic.records")).toBe(false);
    expect((await list()).grants.map((grant) => grant.expired)).toEqual([true]);
  });

  test("a grant with no expiry never appears, and neither does a withdrawn one", async () => {
    const s = store();
    await s.grant(ada, signed(null));
    await s.grant(bob, signed(2));
    clock = new Date(T0.getTime() + DAY);
    await s.withdraw(bob, withdrawal);
    expect((await list()).grants).toEqual([]);
  });

  test("only the latest grant counts: a renewal past the horizon takes the subject off the list", async () => {
    const s = store();
    await s.grant(ada, signed(2));
    clock = new Date(T0.getTime() + DAY);
    await s.grant(ada, signed(200));
    expect((await list()).grants).toEqual([]);
  });

  test("a visitor merged into an account appears once, as that account, agreeing with the counts", async () => {
    const s = store();
    await s.grant(visitor, signed(3));
    clock = new Date(T0.getTime() + 1000);
    await s.merge(visitor.id, ada.id);
    clock = new Date(T0.getTime() + 4 * DAY);

    const page = await list();
    expect(page.grants.map((grant) => grant.subject)).toEqual([ada]);
    expect(page.grants[0]?.expired).toBe(true);
    const counts = await consentCounts(consentDatabase(env.DB), clock);
    expect(counts).toEqual([{ purpose: "clinic.records", noticeVersion: 1, grants: 1, withdrawals: 0, expired: 1 }]);
  });

  test("a merged visitor and the account's own later grant are one history: listed once, by the account's expiry", async () => {
    const s = store();
    await s.grant(visitor, signed(3));
    clock = new Date(T0.getTime() + 1000);
    await s.merge(visitor.id, ada.id);
    clock = new Date(T0.getTime() + 2000);
    await s.grant(ada, signed(10));
    clock = new Date(T0.getTime() + 4 * DAY);

    const page = await list();
    expect(page.grants.map((grant) => ({ subject: grant.subject, expiresAt: grant.expiresAt }))).toEqual([
      { subject: ada, expiresAt: new Date(T0.getTime() + 10 * DAY) },
    ]);
    expect(page.grants[0]?.expired).toBe(false);
    const counts = await consentCounts(consentDatabase(env.DB), clock);
    expect(counts).toEqual([{ purpose: "clinic.records", noticeVersion: 1, grants: 1, withdrawals: 0, expired: 0 }]);
  });

  test("an account's withdrawal after the merge takes the visitor's grant off the list, as the counts read it", async () => {
    const s = store();
    await s.grant(visitor, signed(3));
    clock = new Date(T0.getTime() + 1000);
    await s.merge(visitor.id, ada.id);
    clock = new Date(T0.getTime() + 2000);
    await s.withdraw(ada, withdrawal);
    clock = new Date(T0.getTime() + 4 * DAY);

    expect((await list()).grants).toEqual([]);
    const counts = await consentCounts(consentDatabase(env.DB), clock);
    expect(counts).toEqual([{ purpose: "clinic.records", noticeVersion: 1, grants: 0, withdrawals: 1, expired: 0 }]);
  });

  test("an unmerged visitor is its own subject", async () => {
    await store().grant(visitor, signed(3));
    expect((await list()).grants.map((grant) => grant.subject)).toEqual([visitor]);
  });

  test("each purpose is its own choice, and a purpose outside the catalog is left out", async () => {
    const s = store();
    await s.grant(ada, signed(3, "clinic.records"));
    await s.grant(ada, signed(4, "clinic.research"));
    expect((await list()).grants.map((grant) => grant.purpose)).toEqual(["clinic.records", "clinic.research"]);
    expect((await list({ purposes: ["clinic.research"] })).grants.map((grant) => grant.purpose)).toEqual([
      "clinic.research",
    ]);
    expect((await list({ purposes: [] })).grants).toEqual([]);
  });

  test("pages resume where the last ended, with ties on the expiry broken by record id", async () => {
    const s = store();
    await s.grant(ada, signed(5));
    await s.grant(bob, signed(5));
    await s.grant(cy, signed(1));

    const first = await list({ limit: 2 });
    expect(first.grants.map((grant) => grant.subject)).toEqual([cy, ada]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.grants.map((grant) => grant.subject)).toEqual([bob]);
    expect(second.nextCursor).toBeNull();
  });

  test("a malformed cursor is a first page", async () => {
    await store().grant(ada, signed(5));
    expect((await list({ cursor: "not-a-cursor" })).grants.map((grant) => grant.subject)).toEqual([ada]);
  });
});
