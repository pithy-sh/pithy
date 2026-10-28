// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Every column of `pithy_consent_records` but the two sealed names, as SQL spells them. The update trigger fires on
 * any of these, so the facts a row records cannot be rewritten; the field-key rotator, which re-seals `typed_name`
 * and `representative_name` under a new key version and touches nothing else, still can.
 */
export const RECORD_FACT_COLUMNS = [
  "id",
  "subject_kind",
  "subject_id",
  "purpose",
  "action",
  "notice_version",
  "method",
  "surface",
  "identity",
  "document_hash",
  "drawn_image_hash",
  "drawn_image_type",
  "provider",
  "provider_envelope_id",
  "provider_certificate_hash",
  "expires_at",
  "representative_relationship",
  "recorded_at",
] as const;

/**
 * Creates the consent capability's three tables: the append-only record, the documents kept once per hash, and the
 * merges of visitors into accounts. All identifiers are camelCase; the runner's `CamelCasePlugin` snake-cases them.
 *
 * **Append-only is enforced by the database, not by convention.** Two triggers refuse an `UPDATE` of any fact
 * column and every `DELETE` on `pithy_consent_records`, and a document or a merge, once written, is refused the same
 * way. Nothing in the kit updates or deletes a row here, the account's purge included; the triggers make that a
 * property an auditor can check in the schema rather than a promise in the code.
 */
export const consent_0001_init: Migration = {
  up: async (db: Kysely<unknown>) => {
    await db.schema
      .createTable("pithyConsentRecords")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("subjectKind", "text", (c) => c.notNull())
      .addColumn("subjectId", "text", (c) => c.notNull())
      .addColumn("purpose", "text", (c) => c.notNull())
      .addColumn("action", "text", (c) => c.notNull())
      .addColumn("noticeVersion", "integer", (c) => c.notNull())
      .addColumn("method", "text", (c) => c.notNull())
      .addColumn("surface", "text", (c) => c.notNull())
      .addColumn("identity", "text", (c) => c.notNull())
      .addColumn("documentHash", "text")
      .addColumn("typedName", "text")
      .addColumn("drawnImageHash", "text")
      .addColumn("drawnImageType", "text")
      .addColumn("provider", "text")
      .addColumn("providerEnvelopeId", "text")
      .addColumn("providerCertificateHash", "text")
      .addColumn("expiresAt", "integer")
      .addColumn("representativeName", "text")
      .addColumn("representativeRelationship", "text")
      .addColumn("recordedAt", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("pithyConsentRecordsSubjectIdx")
      .on("pithyConsentRecords")
      .columns(["subjectKind", "subjectId", "purpose", "recordedAt"])
      .execute();
    await db.schema
      .createIndex("pithyConsentRecordsPurposeIdx")
      .on("pithyConsentRecords")
      .columns(["purpose", "noticeVersion", "action"])
      .execute();

    await db.schema
      .createTable("pithyConsentDocuments")
      .addColumn("hash", "text", (c) => c.primaryKey())
      .addColumn("text", "text", (c) => c.notNull())
      .addColumn("keptAt", "integer", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("pithyConsentMerges")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("visitorId", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("mergedAt", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("pithyConsentMergesVisitorIdx")
      .on("pithyConsentMerges")
      .column("visitorId")
      .unique()
      .execute();
    await db.schema.createIndex("pithyConsentMergesUserIdx").on("pithyConsentMerges").column("userId").execute();

    await sql
      .raw(
        `CREATE TRIGGER pithy_consent_records_no_update BEFORE UPDATE OF ${RECORD_FACT_COLUMNS.join(", ")} ON pithy_consent_records BEGIN SELECT RAISE(ABORT, 'pithy_consent_records is append-only'); END`,
      )
      .execute(db);
    for (const table of ["pithy_consent_records", "pithy_consent_documents", "pithy_consent_merges"]) {
      await sql
        .raw(
          `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
        )
        .execute(db);
    }
    for (const table of ["pithy_consent_documents", "pithy_consent_merges"]) {
      await sql
        .raw(
          `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
        )
        .execute(db);
    }
  },

  down: async (db: Kysely<unknown>) => {
    // Dropping a table drops its triggers with it.
    await db.schema.dropIndex("pithyConsentMergesUserIdx").execute();
    await db.schema.dropIndex("pithyConsentMergesVisitorIdx").execute();
    await db.schema.dropTable("pithyConsentMerges").execute();
    await db.schema.dropTable("pithyConsentDocuments").execute();
    await db.schema.dropIndex("pithyConsentRecordsPurposeIdx").execute();
    await db.schema.dropIndex("pithyConsentRecordsSubjectIdx").execute();
    await db.schema.dropTable("pithyConsentRecords").execute();
  },
};
