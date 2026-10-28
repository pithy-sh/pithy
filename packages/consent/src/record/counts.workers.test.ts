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
import { consent_0001_init } from "../migrations/0001_init";
import { consentCounts } from "./counts";
import { consentStore } from "./store";

/**
 * The control plane's counts, on real D1: each person is counted once, by the row `hasConsent` decides on —
 * including a visitor merged into the account they signed in as.
 */

const T0 = new Date("2026-10-27T12:00:00.000Z");

const marketing = (noticeVersion: number): ConsentPurpose =>
  ConsentPurposeSchema.parse({ id: "email.marketing", summary: "News by email.", noticeVersion });

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

function store(noticeVersion = 1) {
  return consentStore({
    db: consentDatabase(env.DB),
    keys: env.PITHY_FIELD_KEYS,
    bucket: env.CONSENT_EVIDENCE,
    purposes: new Map([["email.marketing", marketing(noticeVersion)]]),
    visitorWindowMs: 30 * 86_400_000,
    now: () => clock,
    newId: () => {
      ids += 1;
      return `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`;
    },
  });
}

function tick(ms = 1000): void {
  clock = new Date(clock.getTime() + ms);
}

const ada = { kind: "account" as const, id: "user-ada" };
const bob = { kind: "account" as const, id: "user-bob" };
const visitor = { kind: "visitor" as const, id: "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13" };

const grant = (noticeVersion = 1) => ({
  purpose: "email.marketing",
  noticeVersion,
  method: "click" as const,
  surface: "settings",
});
const withdrawal = { purpose: "email.marketing", method: "click" as const, surface: "settings" };

const counts = () => consentCounts(consentDatabase(env.DB));

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

describe("consentCounts", () => {
  test("a grant later withdrawn counts as one withdrawal and no grant", async () => {
    const s = store();
    await s.grant(ada, grant());
    tick();
    await s.withdraw(ada, withdrawal);
    expect(await counts()).toEqual([{ purpose: "email.marketing", noticeVersion: 1, grants: 0, withdrawals: 1 }]);
  });

  test("grants under two notice versions land in two rows", async () => {
    await store(1).grant(ada, grant(1));
    tick();
    await store(2).grant(bob, grant(2));
    expect(await counts()).toEqual([
      { purpose: "email.marketing", noticeVersion: 1, grants: 1, withdrawals: 0 },
      { purpose: "email.marketing", noticeVersion: 2, grants: 1, withdrawals: 0 },
    ]);
  });

  test("two rows written at one instant resolve to the later one", async () => {
    const s = store();
    await s.grant(ada, grant());
    await s.withdraw(ada, withdrawal);
    expect(await s.hasConsent(ada, "email.marketing")).toBe(false);
    expect(await counts()).toEqual([{ purpose: "email.marketing", noticeVersion: 1, grants: 0, withdrawals: 1 }]);
  });

  test("a merged visitor's grant, withdrawn by the account, counts as one withdrawal and no grant", async () => {
    const s = store();
    await s.grant(visitor, grant());
    tick();
    await s.merge(visitor.id, ada.id);
    tick();
    await s.withdraw(ada, withdrawal);
    expect(await s.hasConsent(ada, "email.marketing")).toBe(false);
    expect(await counts()).toEqual([{ purpose: "email.marketing", noticeVersion: 1, grants: 0, withdrawals: 1 }]);
  });

  test("a merged visitor's grant, never withdrawn, counts once, under the account", async () => {
    const s = store();
    await s.grant(visitor, grant());
    tick();
    await s.merge(visitor.id, ada.id);
    tick();
    await s.grant(ada, grant());
    expect(await counts()).toEqual([{ purpose: "email.marketing", noticeVersion: 1, grants: 1, withdrawals: 0 }]);
  });

  test("an unmerged visitor counts as its own subject", async () => {
    const s = store();
    await s.grant(visitor, grant());
    await s.grant(ada, grant());
    expect(await counts()).toEqual([{ purpose: "email.marketing", noticeVersion: 1, grants: 2, withdrawals: 0 }]);
  });
});
