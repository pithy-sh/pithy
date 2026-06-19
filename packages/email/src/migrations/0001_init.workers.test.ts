import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { EMAIL_MIGRATION_ORDER, EMAIL_SUPPRESSIONS_MIGRATION_ORDER } from "../capability";
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

async function tablesLike(d1: D1Database): Promise<string[]> {
  const rows = await d1
    .prepare("select name from sqlite_master where type = 'table' and name like 'pithy_email_%'")
    .all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events", "kysely_migration", "kysely_migration_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  for (const table of ["pithy_email_suppressions", "kysely_migration", "kysely_migration_lock"]) {
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
      "insert into pithy_email_jobs (id, to_address, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "job-1",
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
