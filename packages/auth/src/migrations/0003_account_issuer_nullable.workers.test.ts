// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { makeAuth } from "../instance/auth";
import { NO_SOCIAL_PROVIDERS } from "../instance/providers";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "./0001_init";
import { auth_0002_session_authenticated_at } from "./0002_session_authenticated_at";
import { AUTH_MIGRATIONS } from "./set";

/**
 * `0003` runs against a database `0001` and `0002` already shaped, so every case here gets there the way an
 * adopter does: the chain as it stood before this migration, then the whole chain. The second run applies
 * `0003` alone, and the ledger says so.
 */
function provider(
  migrations: Record<string, (typeof AUTH_MIGRATIONS)[keyof typeof AUTH_MIGRATIONS]>,
): MigrationProvider {
  const found = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations },
  ]).app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/** The chain an adopter on 1.7.1 already ran. */
const BEFORE = provider({
  "0001_init": auth_0001_init,
  "0002_session_authenticated_at": auth_0002_session_authenticated_at,
});

/**
 * The chain through this migration, with `0003` on top.
 *
 * Not the whole shipped chain, though it was until `0004` landed: every case here reverses the top of
 * whatever it ran, and the subject is `0003`'s `down`, so a migration appended after it would be the one
 * reversed and every rollback case would test the wrong thing.
 */
const ALL = provider({
  "0001_init": auth_0001_init,
  "0002_session_authenticated_at": auth_0002_session_authenticated_at,
  "0003_account_issuer_nullable": AUTH_MIGRATIONS["0003_account_issuer_nullable"],
});

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

async function accountColumns(): Promise<ColumnInfo[]> {
  const rows = await env.DB.prepare(
    "select name, type, \"notnull\", dflt_value, pk from pragma_table_info('pithy_auth_accounts') order by cid",
  ).all<ColumnInfo>();
  return rows.results;
}

async function accountIndexes(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "select name from sqlite_master where type = 'index' and tbl_name = 'pithy_auth_accounts' and sql is not null",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).sort();
}

async function issuerNotNull(): Promise<number | undefined> {
  return (await accountColumns()).find((column) => column.name === "issuer")?.notnull;
}

/** One account row as `0001` required it: every `NOT NULL` column, `issuer` included. */
async function seedAccount(id: string, issuer: string | null, accountId = `${id}-sub`): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_accounts (id, issuer, account_id, provider_id, user_id, access_token, scope, created_at, updated_at) values (?, ?, ?, 'google', ?, ?, 'openid email', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z')",
  )
    .bind(id, issuer, accountId, `user-${id}`, `token-${id}`)
    .run();
}

/**
 * `env.DB`, except that every statement matching `statement` fails when it runs. That is a run that died
 * there: everything sent before it applied, and whatever shared its round trip is rolled back with it.
 * The failure is at execution, not at `prepare`, so a statement queued into a `d1.batch()` fails inside
 * the batch, after the statements ahead of it in that batch have run.
 */
function dyingAt(statement: RegExp): D1Database {
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) =>
          target.prepare(statement.test(query.trim()) ? "select * from pithy_killed_here" : query);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function accounts(): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare("select * from pithy_auth_accounts order by id").all<Record<string, unknown>>();
  return rows.results;
}

beforeEach(async () => {
  for (const table of [
    "pithy_auth_accounts",
    "pithy_auth_accounts_next",
    "pithy_auth_devices",
    "pithy_auth_jwks",
    "pithy_auth_rate_limit",
    "pithy_auth_rotated_tokens",
    "pithy_auth_user_lifecycle",
    "pithy_auth_verification_outcomes",
    "pithy_auth_sessions",
    "pithy_auth_users",
    "pithy_auth_verifications",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
});

describe("auth_0003_account_issuer_nullable", () => {
  test("up runs alone over a database the earlier chain shaped", async () => {
    await runMigrations(env.DB, BEFORE);
    const results = await runMigrations(env.DB, ALL);
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0300_auth_0003_account_issuer_nullable", "Up", "Success"],
    ]);
  });

  test("up relaxes issuer and drops the (issuer, accountId) index, and keeps the userId index", async () => {
    await runMigrations(env.DB, BEFORE);
    expect(await issuerNotNull()).toBe(1);
    expect(await accountIndexes()).toEqual([
      "pithy_auth_accounts_issuer_account_id_idx",
      "pithy_auth_accounts_user_id_idx",
    ]);

    await runMigrations(env.DB, ALL);

    expect(await issuerNotNull()).toBe(0);
    expect(await accountIndexes()).toEqual(["pithy_auth_accounts_user_id_idx"]);
  });

  test("up changes nothing else about the table: every column, type, constraint and position", async () => {
    // The rebuild reads the table it replaces, so this is the case that proves it read it whole. Every
    // column but `issuer` must come back exactly as `0001` declared it.
    await runMigrations(env.DB, BEFORE);
    const before = await accountColumns();
    await runMigrations(env.DB, ALL);
    const after = await accountColumns();

    expect(after).toEqual(before.map((column) => (column.name === "issuer" ? { ...column, notnull: 0 } : column)));
  });

  test("a row written under 0001 survives up with every value intact, issuer included", async () => {
    await runMigrations(env.DB, BEFORE);
    await seedAccount("a1", "https://accounts.google.com");
    await seedAccount("a2", "local:credential");
    const before = await accounts();

    await runMigrations(env.DB, ALL);

    expect(await accounts()).toEqual(before);
    expect(before).toHaveLength(2);
  });

  test("after up an account inserts with no issuer, which is what Better Auth 1.7.3 and later write", async () => {
    await runMigrations(env.DB, ALL);
    await env.DB.prepare(
      "insert into pithy_auth_accounts (id, account_id, provider_id, user_id, created_at, updated_at) values ('a1', 'u@test.com', 'credential', 'user-1', 'now', 'now')",
    ).run();
    expect((await accounts())[0]?.issuer).toBeNull();
  });

  test("up keeps a column and an index an adopter's plugin added to the table, with its data", async () => {
    // A plugin's `0002_plugin_<id>` sorts before `0003` and may widen this table. A rebuild from a column
    // list written in the migration would drop the column and its values without a word.
    await runMigrations(env.DB, BEFORE);
    await env.DB.prepare("alter table pithy_auth_accounts add column plugin_tenant text").run();
    await env.DB.prepare(
      "create index pithy_auth_accounts_plugin_tenant_idx on pithy_auth_accounts (plugin_tenant)",
    ).run();
    await seedAccount("a1", "https://accounts.google.com");
    await env.DB.prepare("update pithy_auth_accounts set plugin_tenant = 'acme' where id = 'a1'").run();

    await runMigrations(env.DB, ALL);

    expect((await accounts())[0]?.plugin_tenant).toBe("acme");
    expect(await accountIndexes()).toEqual([
      "pithy_auth_accounts_plugin_tenant_idx",
      "pithy_auth_accounts_user_id_idx",
    ]);
  });

  test("up recovers from a rebuild an earlier run left half-done", async () => {
    // D1 has no transactional DDL. A run that died after creating the new table leaves it beside the
    // intact old one, and the retry has to get past it without losing a row.
    await runMigrations(env.DB, BEFORE);
    await seedAccount("a1", "https://accounts.google.com");
    await env.DB.prepare("create table pithy_auth_accounts_next (id text primary key, junk text)").run();
    await env.DB.prepare("insert into pithy_auth_accounts_next (id, junk) values ('stale', 'x')").run();
    const before = await accounts();

    await runMigrations(env.DB, ALL);

    expect(await accounts()).toEqual(before);
    expect(await issuerNotNull()).toBe(0);
  });

  test("a run that dies just before the old table is dropped leaves its indexes for the retry", async () => {
    // The retry reads the indexes off the live table, so whatever the dead run removed from it is gone
    // for good. Killed at the last statement before `drop table`, the original must still carry them.
    await runMigrations(env.DB, BEFORE);
    await seedAccount("a1", "https://accounts.google.com");
    const before = await accounts();

    await expect(runMigrations(dyingAt(/^drop table "pithy_auth_accounts"$/), ALL)).rejects.toThrow();
    expect(await accountIndexes()).toContain("pithy_auth_accounts_user_id_idx");

    await runMigrations(env.DB, ALL);

    expect(await accountIndexes()).toEqual(["pithy_auth_accounts_user_id_idx"]);
    expect(await accounts()).toEqual(before);
    expect(await issuerNotNull()).toBe(0);
  });

  test("a run that dies at the rename leaves the original table whole for the retry", async () => {
    // The drop and the rename share one batch, so a rename that fails takes the drop back with it. Were
    // they separate round trips, the retry would find no accounts table and every row in `_next`.
    await runMigrations(env.DB, BEFORE);
    await seedAccount("a1", "https://accounts.google.com");
    const before = await accounts();

    await expect(
      runMigrations(dyingAt(/^alter table "pithy_auth_accounts_next" rename to "pithy_auth_accounts"$/), ALL),
    ).rejects.toThrow();
    expect(await accounts()).toEqual(before);
    expect(await issuerNotNull()).toBe(1);
    expect(await accountIndexes()).toContain("pithy_auth_accounts_user_id_idx");

    await runMigrations(env.DB, ALL);

    expect(await accountIndexes()).toEqual(["pithy_auth_accounts_user_id_idx"]);
    expect(await accounts()).toEqual(before);
    expect(await issuerNotNull()).toBe(0);
  });

  test("a run that dies recreating an index loses no index, the kit's or a plugin's", async () => {
    // The recreates share the drop's batch too. Were they separate, the retry would read the indexes off
    // the renamed table, find none, recreate none and record Success. SQLite stores each index's DDL with
    // `CREATE INDEX` upper-cased, hence the `i`.
    await runMigrations(env.DB, BEFORE);
    await env.DB.prepare("alter table pithy_auth_accounts add column plugin_tenant text").run();
    await env.DB.prepare(
      "create index pithy_auth_accounts_plugin_tenant_idx on pithy_auth_accounts (plugin_tenant)",
    ).run();
    await seedAccount("a1", "https://accounts.google.com");
    const before = await accounts();

    await expect(runMigrations(dyingAt(/^create index "pithy_auth_accounts_user_id_idx"/i), ALL)).rejects.toThrow();
    expect(await accounts()).toEqual(before);
    expect(await accountIndexes()).toEqual([
      "pithy_auth_accounts_plugin_tenant_idx",
      "pithy_auth_accounts_user_id_idx",
    ]);

    await runMigrations(env.DB, ALL);

    expect(await accountIndexes()).toEqual([
      "pithy_auth_accounts_plugin_tenant_idx",
      "pithy_auth_accounts_user_id_idx",
    ]);
    expect(await accounts()).toEqual(before);
    expect(await issuerNotNull()).toBe(0);
  });

  test("a down that dies before the unique index loses neither the table nor its NOT NULL", async () => {
    await runMigrations(env.DB, ALL);
    await seedAccount("a1", "https://accounts.google.com");
    const before = await accounts();

    await expect(
      rollbackMigration(dyingAt(/^create unique index "pithy_auth_accounts_issuer_account_id_idx"/), ALL),
    ).rejects.toThrow();
    expect(await accounts()).toEqual(before);
    expect(await issuerNotNull()).toBe(0);
    expect(await accountIndexes()).toEqual(["pithy_auth_accounts_user_id_idx"]);

    await rollbackMigration(env.DB, ALL);

    expect(await issuerNotNull()).toBe(1);
    expect(await accountIndexes()).toEqual([
      "pithy_auth_accounts_issuer_account_id_idx",
      "pithy_auth_accounts_user_id_idx",
    ]);
    expect(await accounts()).toEqual(before);
  });

  test("down restores NOT NULL and the unique index, and keeps every row", async () => {
    await runMigrations(env.DB, BEFORE);
    await seedAccount("a1", "https://accounts.google.com");
    const before = await accounts();
    await runMigrations(env.DB, ALL);

    const results = await rollbackMigration(env.DB, ALL);

    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0300_auth_0003_account_issuer_nullable", "Down", "Success"],
    ]);
    expect(await issuerNotNull()).toBe(1);
    expect(await accountIndexes()).toEqual([
      "pithy_auth_accounts_issuer_account_id_idx",
      "pithy_auth_accounts_user_id_idx",
    ]);
    expect(await accounts()).toEqual(before);

    // The constraint holds again, and so does the index.
    await expect(seedAccount("a2", null)).rejects.toThrow(/NOT NULL/);
    await expect(seedAccount("a3", "https://accounts.google.com", "a1-sub")).rejects.toThrow(/UNIQUE/);
  });

  test("down then up again is the same schema up left", async () => {
    await runMigrations(env.DB, ALL);
    const once = await accountColumns();
    await rollbackMigration(env.DB, ALL);
    await runMigrations(env.DB, ALL);
    expect(await accountColumns()).toEqual(once);
    expect(await accountIndexes()).toEqual(["pithy_auth_accounts_user_id_idx"]);
  });

  test("down refuses when a row has no issuer, and changes nothing", async () => {
    // Every account Better Auth 1.7.3 and later creates is such a row, so this is the ordinary case for a
    // Worker that has signed anyone up since. D1 has no transactional DDL: the refusal must come first.
    await runMigrations(env.DB, ALL);
    await seedAccount("a1", null);
    const before = await accountColumns();

    await expect(rollbackMigration(env.DB, ALL)).rejects.toThrow(/1 account row\(s\) have no issuer/);

    expect(await accountColumns()).toEqual(before);
    expect(await accountIndexes()).toEqual(["pithy_auth_accounts_user_id_idx"]);
    expect(await accounts()).toHaveLength(1);
  });

  test("down refuses when two rows share an (issuer, accountId), and changes nothing", async () => {
    await runMigrations(env.DB, ALL);
    await seedAccount("a1", "https://accounts.google.com", "same-sub");
    await seedAccount("a2", "https://accounts.google.com", "same-sub");

    await expect(rollbackMigration(env.DB, ALL)).rejects.toThrow(/1 pair\(s\) are held by more than one row/);

    expect(await issuerNotNull()).toBe(0);
    expect(await accounts()).toHaveLength(2);
  });
});

/** The kit's own instance over this database, with a mailbox for the codes it sends. */
function kitInstance(codes: string[] = []) {
  return makeAuth({
    db: authDatabase(env.DB),
    secret: "test-secret-please-rotate-0000000000",
    baseURL: "http://localhost",
    basePath: "/auth",
    trustedOrigins: ["http://localhost"],
    ...NO_SOCIAL_PROVIDERS,
    sendEmail: async (message) => {
      if (message.template === "otp") codes.push(message.code);
      return { delivery: "queued" };
    },
    sessionExpiresIn: 604800,
    sessionUpdateAge: 86400,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    providerSignUp: { google: true, apple: true, facebook: true, github: true, microsoft: true },
    emit: async () => undefined,
    plugins: [],
  });
}

/** Sign `email` in with an emailed code and hand back who it signed in. */
async function signInWithCode(email: string): Promise<{ userId: string; token: string }> {
  const codes: string[] = [];
  const instance = kitInstance(codes);
  await instance.api.sendVerificationOTP({ body: { email, type: "sign-in" }, headers: new Headers() });
  const code = codes[0];
  if (!code) throw new Error("no code was mailed");
  const signedIn = await instance.api.signInEmailOTP({ body: { email, otp: code }, headers: new Headers() });
  return { userId: signedIn.user.id, token: signedIn.token };
}

/**
 * Attach a provider identity to `userId` the way the OAuth callback does, through `internalAdapter` and
 * with exactly the fields Better Auth writes. This is the insert `issuer`'s `NOT NULL` refused.
 */
async function attachProvider(userId: string, accountId: string): Promise<void> {
  const ctx = await kitInstance().$context;
  const created = await ctx.internalAdapter.createAccount({ userId, providerId: "github", accountId });
  if (!created) throw new Error("account row not created");
}

describe("signing in on Better Auth 1.7.3 and later", () => {
  test("a fresh install signs a person in with a code, and attaches a provider with no issuer", async () => {
    await runMigrations(env.DB, ALL);
    const { userId, token } = await signInWithCode("new@example.test");
    expect(token).toEqual(expect.any(String));

    await attachProvider(userId, "gh-1");
    const rows = await env.DB.prepare("select provider_id, issuer from pithy_auth_accounts where user_id = ?")
      .bind(userId)
      .all<{ provider_id: string; issuer: string | null }>();
    expect(rows.results).toContainEqual({ provider_id: "github", issuer: null });
  });

  test("the schema every Worker held before 0003 refuses that insert, which is #787", async () => {
    // The failure, reproduced at the installed version, so the case above is known to be the fix.
    await runMigrations(env.DB, BEFORE);
    const { userId } = await signInWithCode("new@example.test");
    await expect(attachProvider(userId, "gh-1")).rejects.toThrow(
      /NOT NULL constraint failed: pithy_auth_accounts\.issuer/,
    );
  });

  test("a Worker migrated under 1.7.1 keeps every account through 0003, and goes on signing people in", async () => {
    await runMigrations(env.DB, BEFORE);
    // A person who signed up under 1.7.1, whose account carries the issuer that version wrote.
    await env.DB.prepare(
      "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values ('user-legacy', '', 'legacy@example.test', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
    ).run();
    await env.DB.prepare(
      "insert into pithy_auth_accounts (id, issuer, account_id, provider_id, user_id, created_at, updated_at) values ('acct-legacy', 'https://github.com', 'gh-legacy', 'github', 'user-legacy', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
    ).run();
    await seedAccount("acct-google", "https://accounts.google.com");
    const before = await accounts();

    await runMigrations(env.DB, ALL);

    // The person from before signs in as themselves, by code and by the provider they attached: the
    // callback finds an account by `(providerId, accountId)`, which `0003` left untouched.
    expect((await signInWithCode("legacy@example.test")).userId).toBe("user-legacy");
    const ctx = await kitInstance().$context;
    const owner = await ctx.internalAdapter.findAccountOwnerByKey({ providerId: "github", accountId: "gh-legacy" });
    expect(owner?.kind === "owned" ? owner.user.id : owner?.kind).toBe("user-legacy");
    // Someone new signs up and attaches a provider, which is the insert that failed.
    const fresh = await signInWithCode("new@example.test");
    expect(fresh.userId).not.toBe("user-legacy");
    await attachProvider(fresh.userId, "gh-new");

    // Nothing that was there is gone or changed.
    const after = await accounts();
    for (const row of before) expect(after).toContainEqual(row);
    expect(after).toHaveLength(before.length + 1);
  });
});
