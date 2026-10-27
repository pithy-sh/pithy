// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The hash chain — `#822`.
 *
 * Four columns, every one nullable and none back-filled. `chainSeq` is an event's 1-based position in its tenant's
 * chain, `chainPrev` the hash of the event before it, `chainHash` its own hash over the canonical serialization
 * (`@pithy-sh/core/src/audit/chain`), and `chainSalt` the per-event salt its IP, user-agent and metadata are
 * committed under.
 *
 * **A row written before this migration keeps all four null, and that is its mark: before the chain.** Asserting a
 * chain over rows nobody checked when they were written would be a claim, not evidence, so nothing here computes
 * one.
 *
 * **Two partial unique indexes, one per kind of chain.** The tenant column is nullable and SQLite treats nulls as
 * distinct in a unique index, so one index on `(tenant, chainSeq)` would let the untenanted chain hold two events
 * at one position. Splitting by `tenant is null` closes that, and gives the verify walk an index in chain order for
 * either kind. The recorder's append is already one compare-and-set statement; these are the backstop under it.
 *
 * **Appended, never folded into `0001`.** The audit capability has shipped, so its table is history.
 */
export const audit_0005_chain: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.alterTable("pithyAuditEvents").addColumn("chainSeq", "integer").execute();
    await db.schema.alterTable("pithyAuditEvents").addColumn("chainPrev", "text").execute();
    await db.schema.alterTable("pithyAuditEvents").addColumn("chainHash", "text").execute();
    await db.schema.alterTable("pithyAuditEvents").addColumn("chainSalt", "text").execute();
    await db.schema
      .createIndex("pithyAuditEventsTenantChainIdx")
      .on("pithyAuditEvents")
      .columns(["tenant", "chainSeq"])
      .unique()
      .where(sql.ref("tenant"), "is not", null)
      .execute();
    await db.schema
      .createIndex("pithyAuditEventsUntenantedChainIdx")
      .on("pithyAuditEvents")
      .column("chainSeq")
      .unique()
      .where(sql.ref("tenant"), "is", null)
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyAuditEventsUntenantedChainIdx").execute();
    await db.schema.dropIndex("pithyAuditEventsTenantChainIdx").execute();
    await db.schema.alterTable("pithyAuditEvents").dropColumn("chainSalt").execute();
    await db.schema.alterTable("pithyAuditEvents").dropColumn("chainHash").execute();
    await db.schema.alterTable("pithyAuditEvents").dropColumn("chainPrev").execute();
    await db.schema.alterTable("pithyAuditEvents").dropColumn("chainSeq").execute();
  },
};
