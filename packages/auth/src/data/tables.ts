// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { Account, Jwks, RateLimit, Session, User, Verification } from "./betterAuth";
import { Device } from "./device";
import { RotatedToken } from "./rotatedToken";

/**
 * The auth capability's table map: camelCase keys, so `CamelCasePlugin` emits the snake_case
 * `pithy_auth_*` SQL. One source of truth shared by the capability wiring, the Better-Auth instance
 * (whose Kysely adapter wraps this same Kysely), the device registry, and the migration.
 *
 * The first six tables are Better-Auth-managed; `pithyAuthDevices` and `pithyAuthRotatedTokens` are
 * ours. Setting Better Auth's `modelName` to these exact camelCase keys lets the one `CamelCasePlugin`
 * own the camelCase ↔ snake_case boundary uniformly for both Better Auth's queries and our migration DDL.
 */
export const authTables = {
  pithyAuthUsers: User,
  pithyAuthSessions: Session,
  pithyAuthAccounts: Account,
  pithyAuthVerifications: Verification,
  pithyAuthJwks: Jwks,
  pithyAuthRateLimit: RateLimit,
  pithyAuthDevices: Device,
  pithyAuthRotatedTokens: RotatedToken,
};
export type AuthTables = typeof authTables;

/** The typed Kysely view over the auth tables — shared by the Better-Auth adapter and the device registry. */
export type AuthDatabase = Kysely<DatabaseSchema<AuthTables>>;

/** Build the auth Kysely over a D1 binding. Carries `CamelCasePlugin`, so query code stays camelCase. */
export function authDatabase(d1: D1Database): AuthDatabase {
  return createDatabase(d1, authTables);
}
