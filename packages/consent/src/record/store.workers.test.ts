// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { type ConsentPurpose, ConsentPurpose as ConsentPurposeSchema } from "@pithy-sh/core/src/consent/purpose";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { CONSENT_MIGRATION_ORDER } from "../capability";
import { consentDatabase } from "../data/tables";
import { documentHash, readEvidence, sha256Hex } from "../evidence/evidence";
import { consent_0001_init } from "../migrations/0001_init";
import { consentStore } from "./store";

const T0 = new Date("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;

const PURPOSES: ConsentPurpose[] = [
  ConsentPurposeSchema.parse({ id: "email.marketing", summary: "News by email.", noticeVersion: 1 }),
  ConsentPurposeSchema.parse({
    id: "clinic.records",
    summary: "Store my health record.",
    noticeVersion: 3,
    classes: ["phi"],
    explicit: true,
    minimumMethod: "typed",
    writtenWithdrawal: true,
  }),
];

const DOCUMENT = "I authorize the clinic to keep my health record.\r\nSigned below — with an em dash and é.\n";

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

function store(purposes: ConsentPurpose[] = PURPOSES, windowDays = 30) {
  return consentStore({
    db: consentDatabase(env.DB),
    keys: env.PITHY_FIELD_KEYS,
    bucket: env.CONSENT_EVIDENCE,
    purposes: new Map(purposes.map((purpose) => [purpose.id, purpose])),
    visitorWindowMs: windowDays * DAY,
    now: () => clock,
    newId: () => {
      ids += 1;
      return `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`;
    },
  });
}

const ada = { kind: "account" as const, id: "user-ada" };
const visitor = { kind: "visitor" as const, id: "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13" };

/** Advance the clock, so each row is written at its own instant. */
function tick(ms = 1000): void {
  clock = new Date(clock.getTime() + ms);
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof PithyError ? error.payload.code : String(error);
  }
}

/**
 * What every signed grant records, whatever its method: the document's hash with the text kept under it, the
 * identity the flow declared, the expiry, and the representative read back from D1.
 */
async function expectSignedEvidence(
  s: ReturnType<typeof store>,
  record: { id: string; documentHash: string | null; identity: string; expiresAt: Date | null },
  expected: { identity: string; expiresAt: string; name: string; relationship: string },
): Promise<void> {
  expect(record.documentHash).toBe(await documentHash(DOCUMENT));
  expect((await s.document(record.documentHash ?? ""))?.text).toBe(DOCUMENT);
  expect(record.identity).toBe(expected.identity);
  expect(record.expiresAt?.toISOString()).toBe(expected.expiresAt);
  const read = (await s.record(ada)).find((row) => row.id === record.id);
  expect(read?.identity).toBe(expected.identity);
  expect(read?.documentHash).toBe(record.documentHash);
  expect(String(read?.representativeName)).toBe(expected.name);
  expect(read?.representativeRelationship).toBe(expected.relationship);
}

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

describe("a click grant and its withdrawal", () => {
  test("a grant answers yes, a withdrawal no, and both rows stay", async () => {
    const s = store();
    await s.grant(ada, { purpose: "email.marketing", noticeVersion: 1, method: "click", surface: "settings" });
    expect(await s.hasConsent(ada, "email.marketing")).toBe(true);
    tick();
    await s.withdraw(ada, { purpose: "email.marketing", method: "click", surface: "settings" });
    expect(await s.hasConsent(ada, "email.marketing")).toBe(false);
    const record = await s.record(ada);
    expect(record.map((row) => row.action)).toEqual(["grant", "withdraw"]);
    expect(record[0]?.identity).toBe("session");
  });

  test("a purpose the catalog does not know is refused, and answers no", async () => {
    const s = store();
    expect(await code(s.grant(ada, { purpose: "email.nope", noticeVersion: 1, method: "click", surface: "x" }))).toBe(
      "consent/unknown_purpose",
    );
    expect(await s.hasConsent(ada, "email.nope")).toBe(false);
  });
});

describe("notice versions", () => {
  test("bumping the version answers no for a grant under the older one until it is renewed", async () => {
    await store().grant(ada, { purpose: "email.marketing", noticeVersion: 1, method: "click", surface: "banner" });
    const bumped = [ConsentPurposeSchema.parse({ id: "email.marketing", summary: "News by email.", noticeVersion: 2 })];
    expect(await store(bumped).standingOf(ada, "email.marketing")).toBe("stale_notice");
    expect(
      await code(
        store(bumped).grant(ada, { purpose: "email.marketing", noticeVersion: 1, method: "click", surface: "x" }),
      ),
    ).toBe("consent/stale_notice");
    tick();
    await store(bumped).grant(ada, { purpose: "email.marketing", noticeVersion: 2, method: "click", surface: "x" });
    expect(await store(bumped).hasConsent(ada, "email.marketing")).toBe(true);
  });
});

describe("signed grants", () => {
  test("a grant below the minimum method is refused", async () => {
    const result = code(
      store().grant(ada, { purpose: "clinic.records", noticeVersion: 3, method: "click", surface: "intake" }),
    );
    expect(await result).toBe("consent/method_below_minimum");
  });

  test("a signed grant without its document or its evidence is refused", async () => {
    const s = store();
    expect(
      await code(
        s.grant(ada, { purpose: "clinic.records", noticeVersion: 3, method: "typed", surface: "x", typedName: "Ada" }),
      ),
    ).toBe("consent/evidence_missing");
    expect(
      await code(
        s.grant(ada, {
          purpose: "clinic.records",
          noticeVersion: 3,
          method: "typed",
          surface: "x",
          document: DOCUMENT,
        }),
      ),
    ).toBe("consent/evidence_missing");
  });

  test("typed: the document's hash, the kept text, the identity, the expiry and a representative", async () => {
    const s = store();
    const expiresAt = new Date(T0.getTime() + 365 * DAY).toISOString();
    const record = await s.grant(ada, {
      purpose: "clinic.records",
      noticeVersion: 3,
      method: "typed",
      surface: "intake",
      identity: "in_person",
      document: DOCUMENT,
      typedName: "Grace Lovelace",
      expiresAt,
      representative: { name: "Grace Lovelace", relationship: "parent" },
    });
    expect(record.documentHash).toBe(await documentHash(DOCUMENT));
    expect(record.identity).toBe("in_person");
    expect(record.expiresAt?.toISOString()).toBe(expiresAt);
    // Read back from D1 and opened: the names round-trip.
    const [read] = await s.record(ada);
    expect(String(read?.typedName)).toBe("Grace Lovelace");
    expect(String(read?.representativeName)).toBe("Grace Lovelace");
    expect(read?.representativeRelationship).toBe("parent");
    expect(await s.hasConsent(ada, "clinic.records")).toBe(true);
  });

  test("the typed and representative names rest encrypted, never as plaintext", async () => {
    await store().grant(ada, {
      purpose: "clinic.records",
      noticeVersion: 3,
      method: "typed",
      surface: "intake",
      document: DOCUMENT,
      typedName: "Grace Lovelace",
      representative: { name: "Alan Turing", relationship: "guardian" },
    });
    const raw = await env.DB.prepare("SELECT typed_name, representative_name FROM pithy_consent_records").first<{
      typed_name: string;
      representative_name: string;
    }>();
    expect(raw?.typed_name).not.toContain("Grace");
    expect(raw?.representative_name).not.toContain("Alan");
    expect(JSON.parse(raw?.typed_name ?? "{}")).toHaveProperty("keyVersion");
  });

  test("drawn: the document, identity, expiry and representative, and the image in R2 under its own hash", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const image = btoa(String.fromCharCode(...png));
    const s = store();
    const expiresAt = new Date(T0.getTime() + 90 * DAY).toISOString();
    const record = await s.grant(ada, {
      purpose: "clinic.records",
      noticeVersion: 3,
      method: "drawn",
      surface: "intake",
      identity: "in_person",
      document: DOCUMENT,
      drawn: { image, type: "image/png" },
      expiresAt,
      representative: { name: "Grace Lovelace", relationship: "guardian" },
    });
    await expectSignedEvidence(s, record, {
      identity: "in_person",
      expiresAt,
      name: "Grace Lovelace",
      relationship: "guardian",
    });
    expect(record.drawnImageHash).toBe(await sha256Hex(png));
    expect(record.drawnImageType).toBe("image/png");
    const stored = await readEvidence(env.CONSENT_EVIDENCE, record.drawnImageHash ?? "");
    expect(new Uint8Array(stored?.bytes ?? new ArrayBuffer(0))).toEqual(png);
    expect(stored?.contentType).toBe("image/png");
  });

  test("provider: the document, identity, expiry and representative, the envelope, and the certificate in R2", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7 certificate of completion");
    const s = store();
    const expiresAt = new Date(T0.getTime() + 30 * DAY).toISOString();
    const record = await s.grant(ada, {
      purpose: "clinic.records",
      noticeVersion: 3,
      method: "provider",
      surface: "intake",
      identity: "provider",
      document: DOCUMENT,
      provider: { name: "docusign", envelopeId: "env-123", certificate: btoa(String.fromCharCode(...pdf)) },
      expiresAt,
      representative: { name: "Alan Turing", relationship: "personal representative" },
    });
    await expectSignedEvidence(s, record, {
      identity: "provider",
      expiresAt,
      name: "Alan Turing",
      relationship: "personal representative",
    });
    expect(record.provider).toBe("docusign");
    expect(record.providerEnvelopeId).toBe("env-123");
    expect(record.providerCertificateHash).toBe(await sha256Hex(pdf));
    expect(await readEvidence(env.CONSENT_EVIDENCE, record.providerCertificateHash ?? "")).not.toBeNull();
  });

  test("a drawn or provider grant missing its evidence, or carrying evidence that is not base64, is refused", async () => {
    const s = store();
    const signed = { purpose: "clinic.records", noticeVersion: 3, surface: "x", document: DOCUMENT };
    const refused = [
      { ...signed, method: "drawn" as const },
      { ...signed, method: "drawn" as const, drawn: { image: "%%% not base64 %%%", type: "image/png" as const } },
      { ...signed, method: "drawn" as const, drawn: { image: "", type: "image/png" as const } },
      { ...signed, method: "provider" as const },
      { ...signed, method: "provider" as const, provider: { name: "docusign", envelopeId: "e", certificate: "%%%" } },
      { ...signed, method: "provider" as const, provider: { name: "docusign", envelopeId: "e", certificate: "" } },
    ];
    for (const body of refused) {
      expect(await code(s.grant(ada, body)), JSON.stringify(body).slice(0, 120)).toBe("consent/evidence_missing");
    }
    expect(await s.record(ada)).toEqual([]);
  });

  test("a drawn grant with no evidence bucket bound is refused, naming it", async () => {
    const s = consentStore({
      db: consentDatabase(env.DB),
      keys: env.PITHY_FIELD_KEYS,
      bucket: undefined,
      purposes: new Map(PURPOSES.map((purpose) => [purpose.id, purpose])),
      visitorWindowMs: DAY,
      now: () => clock,
      newId: () => crypto.randomUUID(),
    });
    const result = s.grant(ada, {
      purpose: "clinic.records",
      noticeVersion: 3,
      method: "drawn",
      surface: "x",
      document: DOCUMENT,
      drawn: { image: btoa("img"), type: "image/png" },
    });
    expect(await code(result)).toBe("consent/evidence_store_missing");
  });

  test("the signed document is produced again from the record, byte for byte", async () => {
    const s = store();
    const record = await s.grant(ada, {
      purpose: "clinic.records",
      noticeVersion: 3,
      method: "typed",
      surface: "intake",
      document: DOCUMENT,
      typedName: "Ada",
    });
    const kept = await s.document(record.documentHash ?? "");
    expect(kept?.text).toBe(DOCUMENT);
    expect(new TextEncoder().encode(kept?.text)).toEqual(new TextEncoder().encode(DOCUMENT));
    expect(await documentHash(kept?.text ?? "")).toBe(record.documentHash);
  });

  test("a click, or a click withdrawal, records the document's hash and keeps no text", async () => {
    const s = store();
    const text = "Yes, send me news.";
    const grant = await s.grant(ada, {
      purpose: "email.marketing",
      noticeVersion: 1,
      method: "click",
      surface: "banner",
      document: text,
    });
    tick();
    const withdrawal = await s.withdraw(ada, {
      purpose: "email.marketing",
      method: "click",
      surface: "settings",
      document: "No more news.",
    });
    expect(grant.documentHash).toBe(await documentHash(text));
    expect(withdrawal.documentHash).toBe(await documentHash("No more news."));
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_consent_documents").first<{ n: number }>();
    expect(count?.n).toBe(0);
    expect(await s.document(grant.documentHash ?? "")).toBeNull();
  });

  test("a document is kept once per hash", async () => {
    const s = store();
    for (const name of ["Ada", "Grace"]) {
      await s.grant(ada, {
        purpose: "clinic.records",
        noticeVersion: 3,
        method: "typed",
        surface: "x",
        document: DOCUMENT,
        typedName: name,
      });
      tick();
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_consent_documents").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  test("an expired grant answers no, and an expiry already past is refused", async () => {
    const s = store();
    await s.grant(ada, {
      purpose: "clinic.records",
      noticeVersion: 3,
      method: "typed",
      surface: "x",
      document: DOCUMENT,
      typedName: "Ada",
      expiresAt: new Date(T0.getTime() + DAY).toISOString(),
    });
    expect(await s.hasConsent(ada, "clinic.records")).toBe(true);
    clock = new Date(T0.getTime() + DAY);
    expect(await s.standingOf(ada, "clinic.records")).toBe("expired");
    expect(
      await code(
        s.grant(ada, {
          purpose: "clinic.records",
          noticeVersion: 3,
          method: "typed",
          surface: "x",
          document: DOCUMENT,
          typedName: "Ada",
          expiresAt: clock.toISOString(),
        }),
      ),
    ).toBe("consent/expiry_passed");
  });

  test("a grant recorded before the minimum was raised answers no", async () => {
    await store().grant(ada, { purpose: "email.marketing", noticeVersion: 1, method: "click", surface: "x" });
    const raised = [
      ConsentPurposeSchema.parse({ id: "email.marketing", summary: "x", noticeVersion: 1, minimumMethod: "typed" }),
    ];
    expect(await store(raised).standingOf(ada, "email.marketing")).toBe("below_minimum");
  });
});

describe("a written withdrawal", () => {
  test("is refused below the grant's method, and accepted at it", async () => {
    const s = store();
    await s.grant(ada, {
      purpose: "clinic.records",
      noticeVersion: 3,
      method: "typed",
      surface: "x",
      document: DOCUMENT,
      typedName: "Ada",
    });
    tick();
    expect(await code(s.withdraw(ada, { purpose: "clinic.records", method: "click", surface: "settings" }))).toBe(
      "consent/withdrawal_below_grant",
    );
    expect(await s.hasConsent(ada, "clinic.records")).toBe(true);
    await s.withdraw(ada, { purpose: "clinic.records", method: "typed", surface: "settings", typedName: "Ada" });
    expect(await s.hasConsent(ada, "clinic.records")).toBe(false);
  });

  test("a purpose that does not require one is withdrawn by a click, whatever the grant", async () => {
    const s = store();
    await s.grant(ada, {
      purpose: "email.marketing",
      noticeVersion: 1,
      method: "typed",
      surface: "x",
      document: "Yes.",
      typedName: "Ada",
    });
    tick();
    await s.withdraw(ada, { purpose: "email.marketing", method: "click", surface: "settings" });
    expect(await s.hasConsent(ada, "email.marketing")).toBe(false);
  });
});

describe("visitors", () => {
  test("a visitor's grant ages out on the window when it was never merged", async () => {
    const s = store(PURPOSES, 30);
    await s.grant(visitor, { purpose: "email.marketing", noticeVersion: 1, method: "click", surface: "banner" });
    expect((await s.record(visitor))[0]?.identity).toBe("none");
    expect(await s.hasConsent(visitor, "email.marketing")).toBe(true);
    clock = new Date(T0.getTime() + 30 * DAY);
    expect(await s.standingOf(visitor, "email.marketing")).toBe("visitor_expired");
  });

  test("a visitor cannot claim a session it does not have", async () => {
    const result = store().grant(visitor, {
      purpose: "email.marketing",
      noticeVersion: 1,
      method: "click",
      surface: "banner",
      identity: "session",
    });
    expect(await code(result)).toBe("validation/invalid_input");
  });

  test("a merge carries the visitor's consent into the account, once, and the merged grant does not age out", async () => {
    const s = store(PURPOSES, 30);
    await s.grant(visitor, { purpose: "email.marketing", noticeVersion: 1, method: "click", surface: "banner" });
    tick();
    const first = await s.merge(visitor.id, ada.id);
    expect(first.created).toBe(true);
    const again = await s.merge(visitor.id, ada.id);
    expect(again.created).toBe(false);
    expect(again.merge.id).toBe(first.merge.id);
    expect(await s.hasConsent(ada, "email.marketing")).toBe(true);
    clock = new Date(T0.getTime() + 60 * DAY);
    expect(await s.hasConsent(ada, "email.marketing")).toBe(true);
    expect(await s.hasConsent(visitor, "email.marketing")).toBe(true);
    // The account withdrawing later decides, over the merged visitor's grant.
    tick();
    await s.withdraw(ada, { purpose: "email.marketing", method: "click", surface: "settings" });
    expect(await s.hasConsent(ada, "email.marketing")).toBe(false);
    expect((await s.record(ada)).map((row) => `${row.subjectKind}:${row.action}`)).toEqual([
      "visitor:grant",
      "account:withdraw",
    ]);
  });
});

describe("the record is append-only", () => {
  test("an update of a fact and any delete are refused by the database", async () => {
    // A signed document, so the documents table holds a row for its trigger to refuse.
    await store().grant(ada, {
      purpose: "email.marketing",
      noticeVersion: 1,
      method: "typed",
      surface: "x",
      document: "Yes, send me news.",
      typedName: "Ada",
    });
    await expect(env.DB.exec("UPDATE pithy_consent_records SET action = 'withdraw'")).rejects.toThrow(/append-only/);
    await expect(env.DB.exec("UPDATE pithy_consent_records SET recorded_at = 0")).rejects.toThrow(/append-only/);
    await expect(env.DB.exec("DELETE FROM pithy_consent_records")).rejects.toThrow(/append-only/);
    await expect(env.DB.exec("DELETE FROM pithy_consent_documents")).rejects.toThrow(/append-only/);
    await store().merge(visitor.id, ada.id);
    await expect(env.DB.exec("DELETE FROM pithy_consent_merges")).rejects.toThrow(/append-only/);
    await expect(env.DB.exec("UPDATE pithy_consent_merges SET user_id = 'mallory'")).rejects.toThrow(/append-only/);
  });

  test("re-sealing a name under a new key version, the rotator's one write, is still allowed", async () => {
    await store().grant(ada, {
      purpose: "clinic.records",
      noticeVersion: 3,
      method: "typed",
      surface: "x",
      document: DOCUMENT,
      typedName: "Ada",
    });
    await env.DB.exec("UPDATE pithy_consent_records SET typed_name = typed_name");
    expect(await store().hasConsent(ada, "clinic.records")).toBe(true);
  });
});
