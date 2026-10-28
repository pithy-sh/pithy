// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { CONSENT_MIGRATION_ORDER, consent } from "../capability";
import { consentDatabase } from "../data/tables";
import { consent_0001_init } from "../migrations/0001_init";
import { consentStandings } from "./standings";
import { consentStore } from "./store";

const T0 = new Date("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;
const WINDOW = 30 * DAY;

const marketing = (noticeVersion: number, minimumMethod: "click" | "typed" = "click") =>
  ConsentPurpose.parse({ id: "email.marketing", summary: "News by email.", noticeVersion, minimumMethod });

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

function store(purpose = marketing(1)) {
  return consentStore({
    db: consentDatabase(env.DB),
    keys: env.PITHY_FIELD_KEYS,
    bucket: env.CONSENT_EVIDENCE,
    purposes: new Map([[purpose.id, purpose]]),
    visitorWindowMs: WINDOW,
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
const merged = { kind: "visitor" as const, id: "7a2e3f51-8c4b-4d0f-9e62-3b5c7d9f1a24" };

const grant = (extra: Record<string, unknown> = {}) => ({
  purpose: "email.marketing",
  noticeVersion: 1,
  method: "click" as const,
  surface: "settings",
  ...extra,
});

const standings = (purpose = marketing(1)) =>
  consentStandings(consentDatabase(env.DB), new Map([[purpose.id, purpose]]), clock, WINDOW);

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

describe("consentStandings", () => {
  test("counts a subject as standing exactly when hasConsent answers yes for it", async () => {
    const s = store();
    await s.grant(ada, grant());
    await s.grant(bob, grant({ expiresAt: new Date(T0.getTime() + DAY).toISOString() }));
    await s.grant(visitor, grant());
    await s.grant(merged, grant());
    await s.merge(merged.id, cy.id);
    await s.withdraw(
      { kind: "account", id: "user-dee" },
      { purpose: "email.marketing", method: "click", surface: "x" },
    );
    clock = new Date(T0.getTime() + 31 * DAY);

    const [tally] = await standings();
    const answers = await Promise.all(
      [ada, bob, visitor, cy].map((subject) => s.hasConsent(subject, "email.marketing")),
    );
    expect(answers).toEqual([true, false, false, true]);
    expect(tally).toMatchObject({ grants: 4, withdrawals: 1, standing: 2 });
  });

  test("a grant under an older notice version, or below a raised minimum, does not stand", async () => {
    await store().grant(ada, grant());
    expect((await standings(marketing(2)))[0]).toMatchObject({ grants: 1, standing: 0 });
    expect((await standings(marketing(1, "typed")))[0]).toMatchObject({ grants: 1, standing: 0 });
  });
});

describe("the consent seam's standings", () => {
  test("lists every catalog purpose, the adopter's own included, through the reader a capability finds", async () => {
    await store().grant(ada, grant());
    const capability = consent({ purposes: [{ id: "clinic.records", summary: "Keep my record.", noticeVersion: 1 }] });
    const reader = capability.consentReader?.(env as unknown as Record<string, unknown>);
    const listed = await reader?.standings?.();
    expect(listed?.map((entry) => [entry.purpose.id, entry.standing])).toEqual([["clinic.records", 0]]);
  });

  test("lists the catalog without the record, and refuses standings with no database bound", async () => {
    const capability = consent({ purposes: [{ id: "clinic.records", summary: "Keep my record.", noticeVersion: 1 }] });
    const reader = capability.consentReader?.({});
    expect(reader?.purposes?.().map((purpose) => purpose.id)).toEqual(["clinic.records"]);
    await expect(reader?.standings?.()).rejects.toThrow(/DB/);
  });
});
