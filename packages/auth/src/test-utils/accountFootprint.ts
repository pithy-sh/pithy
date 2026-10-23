// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";

/**
 * One account's rows across every `pithy_auth_*` table that keys a row to a person — what a purge must erase
 * and an export must read (#622). For the workers suites; the tables are the real ones, written by raw SQL in
 * the shapes the kit's own writers produce, so a test reads back exactly what production would hold.
 */

const AT = "2026-10-01T00:00:00.000Z";
const AT_MS = Date.parse(AT);

/** Every table a footprint writes to, with the column that names the person in it. */
export const FOOTPRINT_TABLES = [
  ["pithy_auth_users", "id"],
  ["pithy_auth_sessions", "user_id"],
  ["pithy_auth_accounts", "user_id"],
  ["pithy_auth_devices", "user_id"],
  ["pithy_auth_rotated_tokens", "user_id"],
] as const;

/** Write a full footprint for one account: a user, a session, a provider link, a device, a spent token, two pending codes. */
export async function seedAccountFootprint(
  d1: D1Database,
  userId: string,
  email = `${userId}@test.com`,
): Promise<void> {
  await d1.batch([
    d1
      .prepare(
        "insert into pithy_auth_users (id, name, email, email_verified, locale, created_at, updated_at) values (?, 'Sam', ?, 1, null, ?, ?)",
      )
      .bind(userId, email, AT, AT),
    d1
      .prepare(
        "insert into pithy_auth_sessions (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id, device_id) values (?, ?, ?, ?, ?, '203.0.113.9', 'Pithy/1.0', ?, ?)",
      )
      .bind(`s-${userId}`, "2099-01-01T00:00:00.000Z", `token-${userId}`, AT, AT, userId, `d-${userId}`),
    d1
      .prepare(
        "insert into pithy_auth_accounts (id, account_id, provider_id, user_id, access_token, refresh_token, created_at, updated_at) values (?, ?, 'google', ?, ?, ?, ?, ?)",
      )
      .bind(`a-${userId}`, `g-${userId}`, userId, `access-${userId}`, `refresh-${userId}`, AT, AT),
    d1
      .prepare(
        "insert into pithy_auth_devices (id, user_id, platform, push_token, last_ip, last_seen_at, created_at) values (?, ?, 'ios', ?, '203.0.113.9', ?, ?)",
      )
      .bind(`d-${userId}`, userId, `push-${userId}`, AT_MS, AT_MS),
    d1
      .prepare("insert into pithy_auth_rotated_tokens (token, family_id, user_id, rotated_at) values (?, ?, ?, ?)")
      .bind(`spent-${userId}`, `f-${userId}`, userId, AT_MS),
    d1
      .prepare(
        "insert into pithy_auth_verifications (id, identifier, value, expires_at, created_at, updated_at) values (?, ?, '123456:0', ?, ?, ?)",
      )
      .bind(`otp-${userId}`, `sign-in-otp-${email}`, "2099-01-01T00:00:00.000Z", AT, AT),
    d1
      .prepare(
        "insert into pithy_auth_verifications (id, identifier, value, expires_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `link-${userId}`,
        `magic-link-${userId}`,
        JSON.stringify({ email, name: "", attempt: 0 }),
        "2099-01-01T00:00:00.000Z",
        AT,
        AT,
      ),
  ]);
}

/** How many rows one account still holds in each footprint table, and in the pending codes for its address. */
export async function footprintCounts(d1: D1Database, userId: string, email = `${userId}@test.com`) {
  const counts: Record<string, number> = {};
  for (const [table, column] of FOOTPRINT_TABLES) {
    const row = await d1
      .prepare(`select count(*) as n from ${table} where ${column} = ?`)
      .bind(userId)
      .first<{ n: number }>();
    counts[table] = row?.n ?? 0;
  }
  const codes = await d1
    .prepare("select count(*) as n from pithy_auth_verifications where identifier = ? or instr(value, ?) > 0")
    .bind(`sign-in-otp-${email}`, JSON.stringify(email))
    .first<{ n: number }>();
  counts.pithy_auth_verifications = codes?.n ?? 0;
  const history = await d1
    .prepare("select count(*) as n from pithy_auth_user_lifecycle where user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  counts.pithy_auth_user_lifecycle = history?.n ?? 0;
  return counts;
}
