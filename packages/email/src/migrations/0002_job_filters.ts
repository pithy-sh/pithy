// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The send log filtered by template or by category, newest first.
 *
 * `GET {base}/jobs?template=…` and `?category=…` page `pithy_email_jobs` on `(createdAt, id)` under one equality.
 * Without an index led by the filtered column, SQLite walks `pithyEmailJobsCreatedIdx` and tests every job the
 * project ever queued, and a template nobody has sent in a year is the whole table. `createdAt` second, so the
 * filtered page is read in order and stops at the limit.
 *
 * **Appended, never folded into `0001`.** The email capability has shipped, so its table is history.
 */
export const email_0002_job_filters: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createIndex("pithyEmailJobsTemplateCreatedIdx")
      .on("pithyEmailJobs")
      .columns(["template", "createdAt"])
      .execute();
    await db.schema
      .createIndex("pithyEmailJobsCategoryCreatedIdx")
      .on("pithyEmailJobs")
      .columns(["category", "createdAt"])
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyEmailJobsCategoryCreatedIdx").execute();
    await db.schema.dropIndex("pithyEmailJobsTemplateCreatedIdx").execute();
  },
};
