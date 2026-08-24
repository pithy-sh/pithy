// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { EMAIL_MIGRATION_ORDER, EMAIL_SUPPRESSIONS_MIGRATION_ORDER } from "../capability";
import { EmailEvent } from "../data/emailEvent";
import { EmailJob } from "../data/emailJob";
import { email_0001_init } from "./0001_init";
import { email_0001_suppressions } from "./0001_suppressions";

/** The email migration sets, as `pithy migrate` composes them per database. */
const APP_SET = {
  database: "app",
  namespace: "email",
  order: EMAIL_MIGRATION_ORDER,
  migrations: { "0001_init": email_0001_init },
} as const;
const SUP_SET = {
  database: "emailSuppressions",
  namespace: "email",
  order: EMAIL_SUPPRESSIONS_MIGRATION_ORDER,
  migrations: { "0001_suppressions": email_0001_suppressions },
} as const;

function provider(database: "app" | "emailSuppressions"): MigrationProvider {
  const registry = createMigrationRegistry([APP_SET, SUP_SET]);
  const found = registry[database];
  if (!found) throw new Error(`expected a provider for database "${database}"`);
  return found;
}

/** The identifier `CamelCasePlugin` emits for a schema field, so the two lists are comparable. */
function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (upper) => `_${upper.toLowerCase()}`);
}

/** The columns D1 actually holds for a table, sorted. */
async function columnsOf(table: string): Promise<string[]> {
  const rows = await env.DB.prepare(`select name from pragma_table_info('${table}')`).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function tablesLike(d1: D1Database): Promise<string[]> {
  const rows = await d1
    .prepare("select name from sqlite_master where type = 'table' and name like 'pithy_email_%'")
    .all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  for (const table of ["pithy_email_suppressions", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.EMAIL_SUPPRESSIONS.prepare(`drop table if exists ${table}`).run();
  }
});

describe("email_0001_init (app database: jobs + events)", () => {
  test("up creates the jobs and events tables and a job row round-trips", async () => {
    const results = await runMigrations(env.DB, provider("app"));
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0200_email_0001_init", "Up", "Success"],
    ]);
    expect(await tablesLike(env.DB)).toEqual(["pithy_email_events", "pithy_email_jobs"]);

    await env.DB.prepare(
      "insert into pithy_email_jobs (id, to_address, recipient_key, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "job-1",
        "u@example.com",
        "u@example.com",
        "noreply@pithy.sh",
        "Pithy",
        "Hi",
        "welcome",
        "transactional",
        "{}",
        "pending",
        "immediate",
        0,
        1000,
        0,
        0,
        1000,
        1000,
      )
      .run();
    const row = await env.DB.prepare("select status, mode from pithy_email_jobs where id = ?")
      .bind("job-1")
      .first<{ status: string; mode: string }>();
    expect(row).toEqual({ status: "pending", mode: "immediate" });
  });

  /**
   * The table and its schema are one definition in two places, and only one of them is compiled.
   *
   * `EmailJob` is what every read and write is validated against; the DDL above is what D1 actually
   * holds. Adding a field to one and forgetting the other is a column that silently reads back
   * `undefined`, or a column nothing can ever write — and neither shows up in a test that inserts the
   * columns it happens to remember. `pithy_email_jobs` gained `batch_id` this way (#342); this is what
   * makes the next one a failure instead of a surprise.
   */
  test("every column of the jobs and events tables is a field of its schema, and the reverse", async () => {
    await runMigrations(env.DB, provider("app"));

    for (const [table, schema] of [
      ["pithy_email_jobs", EmailJob],
      ["pithy_email_events", EmailEvent],
    ] as const) {
      const declared = Object.keys(schema.shape).map(snakeCase).sort();
      expect(declared.length, `${table}: the schema declares no fields`).toBeGreaterThan(5);
      expect(await columnsOf(table)).toEqual(declared);
    }
  });

  /**
   * The read `correlation` exists for, planned rather than measured.
   *
   * `sentSince` asks *what has been said about this thing, since an instant, newest first* — against a
   * table holding every email the project ever queued, on the path that decides whether another letter
   * goes out. Without the index that is a full scan, and it stays *correct* while getting slower for
   * years, which is why no assertion about results can catch it.
   *
   * `pithy-sh/pithy#382`. Six account notices ride one `operationalNotice` template to the same
   * addresses, so `(recipient_key, template)` cannot separate them; this column is what does, and the
   * index leads with it because a correlation names one subject and is selective by construction.
   */
  test("the correlation question is answered from its own index, not by scanning the send log", async () => {
    await runMigrations(env.DB, provider("app"));

    expect(await columnsOf("pithy_email_jobs")).toContain("correlation");

    const plan = await env.DB.prepare(
      "explain query plan select id, status, created_at, sent_at from pithy_email_jobs where correlation = ? and created_at >= ? order by created_at desc, id desc limit ?",
    )
      .bind("plan_ending:org-42", 0, 26)
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(" | ");

    expect(detail).toContain("pithy_email_jobs_correlation_idx");
    expect(detail).not.toContain("SCAN pithy_email_jobs");
  });

  /** Null, never a default: a job whose template already says what it is states no subject, truthfully. */
  test("a job stating no subject holds null there, rather than a fabricated one", async () => {
    await runMigrations(env.DB, provider("app"));

    await env.DB.prepare(
      "insert into pithy_email_jobs (id, to_address, recipient_key, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, created_at, updated_at) values ('job-2', 'u@example.com', 'u@example.com', 'noreply@pithy.sh', 'Pithy', 'Hi', 'magicLink', 'transactional', '{}', 'sent', 'immediate', 1, 1000, 0, 0, 1000, 1000)",
    ).run();

    const row = await env.DB.prepare("select correlation from pithy_email_jobs where id = 'job-2'").first<{
      correlation: string | null;
    }>();
    expect(row?.correlation).toBeNull();
  });

  /**
   * `locale`, folded into `0001_init` on 2026-08-23 (pithy-sh/pithy#441) under the same rule
   * `correlation` was: nothing is published, so the initial migration *is* the schema and a `0002`
   * would be a step from a shape that never ran to one that never shipped.
   *
   * Null, and null is not `en`. A job whose recipient never chose a language renders the kit's English
   * because that is the fallback, not because anybody decided English was right for them — exactly the
   * distinction `pithy_auth_users.locale` draws, and the reason a default here would be a lie the
   * moment a project served a second language.
   */
  test("a job whose recipient chose no language holds null there, not the default locale", async () => {
    await runMigrations(env.DB, provider("app"));

    await env.DB.prepare(
      "insert into pithy_email_jobs (id, to_address, recipient_key, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, created_at, updated_at) values ('job-3', 'u@example.com', 'u@example.com', 'noreply@pithy.sh', 'Pithy', 'Hi', 'magicLink', 'transactional', '{}', 'pending', 'immediate', 0, 1000, 0, 0, 1000, 1000)",
    ).run();
    await env.DB.prepare(
      "insert into pithy_email_jobs (id, to_address, recipient_key, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, created_at, updated_at, locale) values ('job-4', 'v@example.com', 'v@example.com', 'noreply@pithy.sh', 'Pithy', 'Hola', 'magicLink', 'transactional', '{}', 'pending', 'immediate', 0, 1000, 0, 0, 1000, 1000, 'es')",
    ).run();

    const rows = await env.DB.prepare(
      "select id, locale from pithy_email_jobs where id in ('job-3', 'job-4') order by id",
    ).all<{ id: string; locale: string | null }>();
    expect(rows.results).toEqual([
      { id: "job-3", locale: null },
      { id: "job-4", locale: "es" },
    ]);
  });

  test("down drops the app tables and indexes", async () => {
    const p = provider("app");
    await runMigrations(env.DB, p);
    const results = await rollbackMigration(env.DB, p);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0200_email_0001_init", "Down", "Success"],
    ]);
    expect(await tablesLike(env.DB)).toEqual([]);
  });
});

describe("email_0001_suppressions (shared suppression database)", () => {
  test("up creates the suppression table and its unique email index rejects duplicates", async () => {
    const results = await runMigrations(env.EMAIL_SUPPRESSIONS, provider("emailSuppressions"));
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0100_email_0001_suppressions", "Up", "Success"],
    ]);
    expect(await tablesLike(env.EMAIL_SUPPRESSIONS)).toEqual(["pithy_email_suppressions"]);

    const insert = (): Promise<unknown> =>
      env.EMAIL_SUPPRESSIONS.prepare(
        "insert into pithy_email_suppressions (email, reason, created_at) values ('dup@example.com', 'hard_bounce', 1)",
      ).run();
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  test("down drops the suppression table", async () => {
    const p = provider("emailSuppressions");
    await runMigrations(env.EMAIL_SUPPRESSIONS, p);
    const results = await rollbackMigration(env.EMAIL_SUPPRESSIONS, p);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0100_email_0001_suppressions", "Down", "Success"],
    ]);
    expect(await tablesLike(env.EMAIL_SUPPRESSIONS)).toEqual([]);
  });
});
