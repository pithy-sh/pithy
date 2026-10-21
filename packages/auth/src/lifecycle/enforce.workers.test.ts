// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { lifecycleRefusalFor, noteRefusal, noticedRefusal, readLifecycleColumns, suspensionReason } from "./enforce";

/**
 * The reads enforcement makes, on their own (#620). The HTTP suite proves the doors refuse; this proves what
 * each door is handed — which reason is the one in force, what an empty one becomes, and what an account
 * nobody can find reads as.
 */

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_user_lifecycle",
  "pithy_auth_users",
  "pithy_auth_verifications",
];

const NOW = new Date("2026-10-20T12:00:00.000Z");
const db = () => authDatabase(env.DB);

async function seedUser(id = "u1"): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values (?, 'Sam', ?, 1, ?, ?)",
  )
    .bind(id, `${id}@test.com`, NOW.toISOString(), NOW.toISOString())
    .run();
}

/** One history row, written in the order the calls are made. All share one instant, so only the id orders them. */
async function historyRow(action: string, reason: string | null, userId = "u1"): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_user_lifecycle (user_id, action, actor_type, reason, created_at) values (?, ?, 'control-plane', ?, ?)",
  )
    .bind(userId, action, reason, NOW.getTime())
    .run();
}

async function suspendColumns(userId = "u1", until: number | null = null): Promise<void> {
  await env.DB.prepare("update pithy_auth_users set suspended_at = ?, suspended_until = ? where id = ?")
    .bind(NOW.getTime() - 1000, until, userId)
    .run();
}

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
});

describe("suspensionReason", () => {
  test("is the newest suspension's reason, not the first one's", async () => {
    await historyRow("suspended", "First.");
    await historyRow("reinstated", "Cleared.");
    await historyRow("suspended", "Second.");
    expect(await suspensionReason(db(), "u1")).toBe("Second.");
  });

  test("reads only suspensions — a newer row of another kind does not lend its reason", async () => {
    await historyRow("suspended", "Under review.");
    await historyRow("deleted", "Asked by email.");
    expect(await suspensionReason(db(), "u1")).toBe("Under review.");
  });

  test("a reason of only whitespace is no reason", async () => {
    await historyRow("suspended", "   \n\t ");
    expect(await suspensionReason(db(), "u1")).toBeNull();
  });

  test("a suspension written with no reason is null, and so is an account with no history", async () => {
    await historyRow("suspended", null);
    expect(await suspensionReason(db(), "u1")).toBeNull();
    expect(await suspensionReason(db(), "nobody")).toBeNull();
  });

  test("is trimmed", async () => {
    await historyRow("suspended", "  Chargeback under review.  ");
    expect(await suspensionReason(db(), "u1")).toBe("Chargeback under review.");
  });

  test("is one account's, never another's", async () => {
    await historyRow("suspended", "Not yours.", "u2");
    expect(await suspensionReason(db(), "u1")).toBeNull();
  });
});

describe("readLifecycleColumns", () => {
  test("is null for an account that does not exist", async () => {
    expect(await readLifecycleColumns(db(), "nobody")).toBeNull();
  });

  test("decodes the columns as dates, and an account in good standing as all null", async () => {
    await seedUser();
    expect(await readLifecycleColumns(db(), "u1")).toEqual({
      suspendedAt: null,
      suspendedUntil: null,
      deletedAt: null,
      purgeAfter: null,
    });
    await suspendColumns("u1", NOW.getTime() + 60_000);
    const columns = await readLifecycleColumns(db(), "u1");
    expect(columns?.suspendedAt?.getTime()).toBe(NOW.getTime() - 1000);
    expect(columns?.suspendedUntil?.getTime()).toBe(NOW.getTime() + 60_000);
  });
});

describe("lifecycleRefusalFor", () => {
  test("with no columns handed in, reads the row — the sign-in path — and refuses with the reason in force", async () => {
    await seedUser();
    await suspendColumns();
    await historyRow("suspended", "Chargeback under review.");
    const refusal = await lifecycleRefusalFor(db(), "u1", undefined, NOW);
    expect(refusal?.payload).toMatchObject({
      code: "auth/account_suspended",
      status: 403,
      message: "Chargeback under review.",
    });
  });

  test("a suspension with no reason written says so in the kit's words", async () => {
    await seedUser();
    await suspendColumns();
    const refusal = await lifecycleRefusalFor(db(), "u1", null, NOW);
    expect(refusal?.payload.message).toBe("This account is suspended.");
  });

  test("an account with no row reads as active: nothing to refuse, and the sign-in fails on its own terms", async () => {
    expect(await lifecycleRefusalFor(db(), "nobody", undefined, NOW)).toBeNull();
  });

  test("columns handed in are trusted, so the row is not read again", async () => {
    await seedUser();
    await suspendColumns();
    const handed = { suspendedAt: null, suspendedUntil: null, deletedAt: null, purgeAfter: null };
    expect(await lifecycleRefusalFor(db(), "u1", handed, NOW)).toBeNull();
  });

  test("a deleted account is refused as deleted, with its purge date, even while it is also suspended", async () => {
    await seedUser();
    const purgeAfter = new Date(NOW.getTime() + 30 * 86_400_000);
    const refusal = await lifecycleRefusalFor(
      db(),
      "u1",
      { suspendedAt: new Date(NOW.getTime() - 1000), deletedAt: new Date(NOW.getTime() - 500), purgeAfter },
      NOW,
    );
    expect(refusal?.payload).toMatchObject({
      code: "auth/account_deleted",
      params: { purgeAfter: purgeAfter.toISOString() },
    });
  });

  test("a suspension past its end is no refusal", async () => {
    await seedUser();
    await suspendColumns("u1", NOW.getTime() - 1);
    expect(await lifecycleRefusalFor(db(), "u1", undefined, NOW)).toBeNull();
  });
});

describe("noteRefusal", () => {
  test("is remembered for the context it was noted on, and only that one", () => {
    const one = {};
    const other = {};
    const refusal = new PithyError({ code: "auth/account_suspended", status: 403, message: "x" });
    expect(noticedRefusal(one)).toBeUndefined();
    noteRefusal(one, refusal);
    expect(noticedRefusal(one)).toBe(refusal);
    expect(noticedRefusal(other)).toBeUndefined();
  });
});
