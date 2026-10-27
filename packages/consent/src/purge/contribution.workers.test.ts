// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields, isRetained, purgeExports, purgeSteps } from "@pithy-sh/core/src/capability/purge";
import { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import { CONSENT_MIGRATION_ORDER, consent } from "../capability";
import { consentDatabase } from "../data/tables";
import { consent_0001_init } from "../migrations/0001_init";
import { consentStore } from "../record/store";
import { CONSENT_RETENTION_BASIS } from "./contribution";

const purposes = new Map(
  [
    ConsentPurpose.parse({
      id: "clinic.records",
      summary: "Keep my record.",
      noticeVersion: 1,
      minimumMethod: "typed",
    }),
  ].map((purpose) => [purpose.id, purpose]),
);

beforeEach(async () => {
  for (const table of [
    "pithy_consent_records",
    "pithy_consent_documents",
    "pithy_consent_merges",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "consent",
      order: CONSENT_MIGRATION_ORDER,
      migrations: { "0001_init": consent_0001_init },
    },
  ]);
  if (!registry.app) throw new Error("no app provider");
  await runMigrations(env.DB, registry.app);
});

describe("consent's user purge", () => {
  test("retains with a basis, and the export carries the person's rows, names opened, and no credential", async () => {
    const store = consentStore({
      db: consentDatabase(env.DB),
      keys: env.PITHY_FIELD_KEYS,
      bucket: env.CONSENT_EVIDENCE,
      purposes,
      visitorWindowMs: 86_400_000,
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
    });
    const visitorId = crypto.randomUUID();
    await store.grant(
      { kind: "visitor", id: visitorId },
      {
        purpose: "clinic.records",
        noticeVersion: 1,
        method: "typed",
        surface: "banner",
        document: "Keep it.",
        typedName: "Ada",
      },
    );
    await store.merge(visitorId, "ada");
    await store.withdraw(
      { kind: "account", id: "ada" },
      { purpose: "clinic.records", method: "typed", surface: "settings", typedName: "Ada" },
    );

    const capability = consent();
    const [step] = purgeSteps([capability], "user");
    expect(step && isRetained(step.contribution)).toBe(true);
    const [entry] = await purgeExports(step ? [step] : [], {
      subject: { type: "user", id: "ada" },
      env: env as unknown as Record<string, unknown>,
    });
    expect(entry).toMatchObject({
      capability: "consent",
      disposition: "retain",
      basis: CONSENT_RETENTION_BASIS,
      state: "exported",
    });
    const data = entry?.state === "exported" ? entry.data : {};
    const records = data.records as { action: string; typedName: string | null; subject: { kind: string } }[];
    expect(records.map((record) => `${record.subject.kind}:${record.action}`)).toEqual([
      "visitor:grant",
      "account:withdraw",
    ]);
    expect(records[0]?.typedName).toBe("Ada");
    expect((data.merges as unknown[]).length).toBe(1);
    expect(credentialFields(data)).toEqual([]);

    // Retained: nothing a purge could run erases a row, and the table would refuse it anyway.
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_consent_records").first<{ n: number }>();
    expect(count?.n).toBe(2);
  });
});
