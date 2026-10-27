// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { ErasingPurgeContribution, PurgeContext } from "@pithy-sh/core/src/capability/purge";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { type CompiledQuery, type Kysely, type SqlBool, sql } from "kysely";
import { Account, Session, User } from "../data/betterAuth";
import { Device } from "../data/device";
import { type AuthDatabase, authDatabase } from "../data/tables";
import { UserLifecycleEvent } from "../data/userLifecycle";
import { VerificationOutcome } from "../data/verificationOutcome";
import type { AuthUserExport } from "../http/responses";
import { authUserExportView } from "../http/views";

/**
 * Auth's own purge contribution (#622): what erasing one person means for the `pithy_auth_*` tables, and what
 * exporting them hands back.
 *
 * **Every row keyed to the account goes, except its history.** The user row, its sessions, its linked
 * providers, its devices, its refresh-token ledger, any sign-in code or link still pending for its address, its
 * rows in the verification ledger (#829), and its rows in every table a composed Better Auth plugin created keyed by `userId` — a two-factor secret
 * and its backup codes, a passkey, an API key. Those tables have no foreign key to the user row, so deleting
 * it removes nothing from them; they are named by the plugin plan (`../migrations/pluginTables.ts`). `pithy_auth_user_lifecycle` stays: it is the record that the account existed, was deleted and was
 * erased, and it names the account by id and holds nothing else about the person (`../data/userLifecycle.ts`).
 * The rate-limit and JWKS tables are keyed to no person and are not touched.
 *
 * **One transaction.** The deletes are one `d1.batch()`, which D1 runs as one, so a failure leaves every row
 * where it was and the retried step erases the lot. **Idempotent**, as the contract requires: a second run
 * finds no rows and deletes nothing, and succeeds.
 *
 * The purge Workflow runs this step **last**, after every other capability's and after the deletion-complete
 * mail, because the address that mail is sent to lives on the user row this deletes.
 */

/** The one sentence the purge records with this step. */
export const AUTH_PURGE_SUMMARY =
  "Deletes the account, its sessions, linked providers, devices, refresh-token ledger, pending sign-in codes, the record of the sign-in links and codes it was sent, and its rows in the tables its Better Auth plugins created. Its lifecycle history stays.";

/**
 * A plugin table's column that holds a credential — a TOTP secret, backup codes, a key or its hash, a token.
 * The export leaves these out, as it leaves out a session's token and a provider's: an access request is
 * answered with what is held, never with the means to sign in as the person.
 */
const CREDENTIAL_COLUMN = /secret|token|key|code|hash|password|credential/i;

/** The auth Kysely without its table map — a plugin's table is named by the plan, not by `authTables`. */
function untyped(db: AuthDatabase): Kysely<Record<string, Record<string, unknown>>> {
  return db as unknown as Kysely<Record<string, Record<string, unknown>>>;
}

/** The D1 binding the auth tables live in, off a run's env — or a wiring fault naming it. */
function bindingOf(env: Record<string, unknown>, database: string): D1Database {
  const binding = env[database];
  if (typeof binding !== "object" || binding === null) {
    throw new InternalError({
      message: "The auth database is not bound, so this purge step could not run.",
      action: `Bind the ${database} D1 database to the Worker that runs the purge.`,
      detail: `auth purge contribution found no ${database} binding on the env`,
    });
  }
  return binding as D1Database;
}

/** `%` and `_` escaped, so an address is matched as itself inside a LIKE pattern and nothing wider. */
function literal(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Bind a compiled statement to D1, so it can join a `batch`. */
function prepared(d1: D1Database, compiled: CompiledQuery) {
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/**
 * Erase one account's `pithy_auth_*` rows, its history excepted. Succeeds, having found nothing, when they are
 * already gone.
 *
 * The pending sign-in codes are found by the address, which is why it is read first: an email OTP's identifier
 * is `<type>-otp-<address>`, and a magic link's value is JSON carrying `"email":"<address>"`. With the user row
 * already gone there is no address to look for, and none is needed — a code lives for minutes.
 */
export async function eraseAuthUser(
  db: AuthDatabase,
  d1: D1Database,
  userId: string,
  pluginTables: readonly string[] = [],
): Promise<void> {
  const user = await db.selectFrom("pithyAuthUsers").select("email").where("id", "=", userId).executeTakeFirst();
  const statements = [
    db.deleteFrom("pithyAuthSessions").where("userId", "=", userId),
    db.deleteFrom("pithyAuthAccounts").where("userId", "=", userId),
    db.deleteFrom("pithyAuthDevices").where("userId", "=", userId),
    db.deleteFrom("pithyAuthRotatedTokens").where("userId", "=", userId),
    // The sign-in links and codes it was sent (#829). A sign-up nobody completed names no account and holds no
    // address, so there is nothing of the person's in it to find.
    db.deleteFrom("pithyAuthVerificationOutcomes").where("userId", "=", userId),
  ].map((query) => prepared(d1, query.compile()));
  // A plugin's rows, in the same batch: `CamelCasePlugin` snake-cases the table and `user_id` as it does for
  // the plugin's own migration, so the names match what `pithy migrate` created.
  for (const table of pluginTables) {
    statements.push(prepared(d1, untyped(db).deleteFrom(table).where("userId", "=", userId).compile()));
  }
  if (user) {
    const address = literal(user.email);
    const otp = `%-otp-${address}`;
    const changingFrom = `%-otp-${address}-%`;
    const link = `%"email":${literal(JSON.stringify(user.email))}%`;
    // Raw SQL for the predicate, for `users.ts`'s reason: SQLite's `ESCAPE` belongs to the `LIKE` operator, so
    // there is no expression-builder form of it. Both columns are single words, so `CamelCasePlugin` has
    // nothing to rewrite.
    const pending = db
      .deleteFrom("pithyAuthVerifications")
      .where(
        sql<SqlBool>`(identifier like ${otp} escape '\\' or identifier like ${changingFrom} escape '\\' or value like ${link} escape '\\')`,
      );
    statements.push(prepared(d1, pending.compile()));
  }
  statements.push(prepared(d1, db.deleteFrom("pithyAuthUsers").where("id", "=", userId).compile()));
  await d1.batch(statements);
}

/**
 * What auth holds about one account, for an export: the account, its sessions, providers, devices and
 * history, every list whole. `null` when there is no account to export.
 */
export async function exportAuthUser(
  db: AuthDatabase,
  userId: string,
  pluginTables: readonly string[] = [],
): Promise<AuthUserExport | null> {
  const row = await db.selectFrom("pithyAuthUsers").selectAll().where("id", "=", userId).executeTakeFirst();
  if (!row) return null;
  const [sessions, accounts, devices, history, verifications, plugins] = await Promise.all([
    db
      .selectFrom("pithyAuthSessions")
      .selectAll()
      .where("userId", "=", userId)
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .execute(),
    // Two columns, never `select *`: the account row holds the provider's tokens, and they are never loaded.
    db
      .selectFrom("pithyAuthAccounts")
      .select(["providerId", "createdAt"])
      .where("userId", "=", userId)
      .orderBy("providerId", "asc")
      .execute(),
    db
      .selectFrom("pithyAuthDevices")
      .selectAll()
      .where("userId", "=", userId)
      .orderBy("lastSeenAt", "desc")
      .orderBy("id", "desc")
      .execute(),
    db.selectFrom("pithyAuthUserLifecycle").selectAll().where("userId", "=", userId).orderBy("id", "asc").execute(),
    db
      .selectFrom("pithyAuthVerificationOutcomes")
      .selectAll()
      .where("userId", "=", userId)
      .orderBy("issuedAt", "desc")
      .orderBy("id", "desc")
      .execute(),
    Promise.all(pluginTables.map(async (table) => [table, await pluginRows(db, table, userId)] as const)),
  ]);
  return authUserExportView({
    now: new Date(),
    user: User.parse(row),
    sessions: sessions.map((session) => Session.parse(session)),
    accounts: accounts.map((account) => Account.pick({ providerId: true, createdAt: true }).parse(account)),
    devices: devices.map((device) => Device.parse(device)),
    history: history.map((event) => UserLifecycleEvent.parse(event)),
    verifications: verifications.map((row) => VerificationOutcome.parse(row)),
    plugins: Object.fromEntries(plugins),
  });
}

/** One plugin table's rows about the account, every column but a credential's. */
async function pluginRows(db: AuthDatabase, table: string, userId: string): Promise<Record<string, unknown>[]> {
  const rows = await untyped(db).selectFrom(table).selectAll().where("userId", "=", userId).execute();
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([column]) => !CREDENTIAL_COLUMN.test(column))),
  );
}

/**
 * The contribution `auth()` declares, over the D1 binding its config names. The export of an account that is
 * not there is an empty object, which the route never reaches: it answers 404 before it reads any capability.
 */
export function authPurgeContribution(
  database: string,
  pluginTables: readonly string[] = [],
): ErasingPurgeContribution {
  const open = (context: PurgeContext) => {
    const d1 = bindingOf(context.env, database);
    return { d1, db: authDatabase(d1) };
  };
  return {
    subject: "user",
    summary: AUTH_PURGE_SUMMARY,
    erase: async (context) => {
      const { d1, db } = open(context);
      await eraseAuthUser(db, d1, context.subject.id, pluginTables);
    },
    export: async (context) => (await exportAuthUser(open(context).db, context.subject.id, pluginTables)) ?? {},
  };
}
