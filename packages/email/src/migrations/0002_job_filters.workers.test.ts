// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { EMAIL_MIGRATION_ORDER } from "../capability";
import { email_0001_init } from "./0001_init";
import { email_0002_job_filters } from "./0002_job_filters";

/** The send log filtered by template or by category, newest first, served by an index rather than a scan. */

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "email",
      order: EMAIL_MIGRATION_ORDER,
      migrations: { "0001_init": email_0001_init, "0002_job_filters": email_0002_job_filters },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/** The columns of one index, in order, or an empty list when it does not exist. */
async function indexColumns(name: string): Promise<string[]> {
  const rows = await env.DB.prepare(`select name from pragma_index_info('${name}') order by seqno`).all<{
    name: string;
  }>();
  return rows.results.map((row) => row.name);
}

/** The query plan of one filtered page of the log, joined into one line. */
async function plan(column: "template" | "category", value: string): Promise<string> {
  const rows = await env.DB.prepare(
    `explain query plan select * from pithy_email_jobs where ${column} = ? order by created_at desc, id desc limit ?`,
  )
    .bind(value, 26)
    .all<{ detail: string }>();
  return rows.results.map((row) => row.detail).join(" | ");
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("email_0002_job_filters", () => {
  test("indexes template and category, each ahead of the creation time the log is ordered on", async () => {
    await runMigrations(env.DB, provider());
    expect(await indexColumns("pithy_email_jobs_template_created_idx")).toEqual(["template", "created_at"]);
    expect(await indexColumns("pithy_email_jobs_category_created_idx")).toEqual(["category", "created_at"]);
  });

  test("a page filtered by template or by category reads its index, not the whole log", async () => {
    await runMigrations(env.DB, provider());
    const template = await plan("template", "newsletter");
    expect(template).toContain("pithy_email_jobs_template_created_idx");
    expect(template).not.toContain("SCAN pithy_email_jobs");
    const category = await plan("category", "marketing");
    expect(category).toContain("pithy_email_jobs_category_created_idx");
    expect(category).not.toContain("SCAN pithy_email_jobs");
  });

  test("down drops both indexes and keeps every job", async () => {
    const p = provider();
    await runMigrations(env.DB, p);
    await env.DB.prepare(
      "insert into pithy_email_jobs (id, to_address, recipient_key, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, created_at, updated_at) values ('job-1', 'u@example.com', 'u@example.com', 'noreply@pithy.sh', 'Pithy', 'Hi', 'newsletter', 'marketing', '{}', 'sent', 'immediate', 1, 1000, 0, 0, 1000, 1000)",
    ).run();

    const results = await rollbackMigration(env.DB, p);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0200_email_0002_job_filters", "Down", "Success"],
    ]);
    expect(await indexColumns("pithy_email_jobs_template_created_idx")).toEqual([]);
    expect(await indexColumns("pithy_email_jobs_category_created_idx")).toEqual([]);
    expect(await env.DB.prepare("select count(*) as n from pithy_email_jobs").first<{ n: number }>()).toEqual({ n: 1 });
  });

  test("up is reappliable after a rollback", async () => {
    const p = provider();
    await runMigrations(env.DB, p);
    await rollbackMigration(env.DB, p);
    await runMigrations(env.DB, p);
    expect(await indexColumns("pithy_email_jobs_template_created_idx")).toEqual(["template", "created_at"]);
  });
});
