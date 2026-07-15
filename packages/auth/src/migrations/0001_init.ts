import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Create the auth tables in the app database, all prefixed `pithy_auth_` so they never clash with an
 * adopter's own tables. Six are Better-Auth-managed (`users`, `sessions`, `accounts`,
 * `verifications`, `jwks`, `rate_limit`); `devices` (the device registry) and `rotated_tokens` (the
 * refresh-token reuse-detection ledger) are Pithy's own.
 *
 * Identifiers are declared in **camelCase**: the runner installs `CamelCasePlugin`, which snake-cases
 * every identifier in the emitted DDL (CLAUDE.md §Data layer) — and the same plugin lets Better
 * Auth's camelCase queries land on these snake_case columns. Better-Auth `date` columns are **text**
 * (it stores ISO-8601 strings on SQLite; ISO sorts chronologically); Pithy's own device timestamps
 * are **integer** ms-epoch. Foreign keys are omitted to match the repo convention (D1 does not enforce
 * them without a per-connection PRAGMA); linkage is by indexed id columns.
 *
 * `down` is the tested inverse — indexes then tables, in reverse creation order (D1 has no
 * transactional DDL, so order matters).
 */
export const auth_0001_init: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyAuthUsers")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("email", "text", (c) => c.notNull().unique())
      .addColumn("emailVerified", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("image", "text")
      .addColumn("createdAt", "text", (c) => c.notNull())
      .addColumn("updatedAt", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("pithyAuthSessions")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("expiresAt", "text", (c) => c.notNull())
      .addColumn("token", "text", (c) => c.notNull().unique())
      .addColumn("createdAt", "text", (c) => c.notNull())
      .addColumn("updatedAt", "text", (c) => c.notNull())
      .addColumn("ipAddress", "text")
      .addColumn("userAgent", "text")
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("deviceId", "text")
      // The refresh-token family this session belongs to, carried across rotations so a replayed
      // refresh token can revoke the whole chain. Server-set; null until the session is first rotated.
      .addColumn("familyId", "text")
      .execute();

    await db.schema
      .createTable("pithyAuthAccounts")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("accountId", "text", (c) => c.notNull())
      .addColumn("providerId", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("accessToken", "text")
      .addColumn("refreshToken", "text")
      .addColumn("idToken", "text")
      .addColumn("accessTokenExpiresAt", "text")
      .addColumn("refreshTokenExpiresAt", "text")
      .addColumn("scope", "text")
      .addColumn("password", "text")
      .addColumn("createdAt", "text", (c) => c.notNull())
      .addColumn("updatedAt", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("pithyAuthVerifications")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("identifier", "text", (c) => c.notNull())
      .addColumn("value", "text", (c) => c.notNull())
      .addColumn("expiresAt", "text", (c) => c.notNull())
      .addColumn("createdAt", "text", (c) => c.notNull())
      .addColumn("updatedAt", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("pithyAuthJwks")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("publicKey", "text", (c) => c.notNull())
      .addColumn("privateKey", "text", (c) => c.notNull())
      .addColumn("createdAt", "text", (c) => c.notNull())
      .addColumn("expiresAt", "text")
      .execute();

    await db.schema
      .createTable("pithyAuthRateLimit")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("key", "text", (c) => c.notNull().unique())
      .addColumn("count", "integer", (c) => c.notNull())
      .addColumn("lastRequest", "integer", (c) => c.notNull())
      .execute();

    // Composite PK `(userId, id)`: `id` is a client-generated device id, unique *per user*. This
    // isolates devices across users — a client passing another user's device id can never touch their
    // row — and gives the userId-prefix index for free (so no separate index needed).
    await db.schema
      .createTable("pithyAuthDevices")
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("platform", "text", (c) => c.notNull())
      .addColumn("name", "text")
      .addColumn("model", "text")
      .addColumn("osVersion", "text")
      .addColumn("appVersion", "text")
      .addColumn("pushToken", "text")
      .addColumn("lastIp", "text")
      .addColumn("lastSeenAt", "integer", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("pithyAuthDevicesPk", ["userId", "id"])
      .execute();

    // The reuse-detection ledger: one row per refresh token consumed by a rotation. Presenting a
    // recorded token again (after it no longer resolves to a live session) is a replayed refresh
    // credential; its `familyId` drives family revocation (RFC 6819 §5.2.2.3). Ms-epoch `rotatedAt`.
    await db.schema
      .createTable("pithyAuthRotatedTokens")
      .addColumn("token", "text", (c) => c.primaryKey())
      .addColumn("familyId", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("rotatedAt", "integer", (c) => c.notNull())
      .execute();

    await db.schema.createIndex("pithyAuthSessionsUserIdIdx").on("pithyAuthSessions").column("userId").execute();
    await db.schema.createIndex("pithyAuthSessionsDeviceIdIdx").on("pithyAuthSessions").column("deviceId").execute();
    await db.schema.createIndex("pithyAuthAccountsUserIdIdx").on("pithyAuthAccounts").column("userId").execute();
    await db.schema
      .createIndex("pithyAuthVerificationsIdentifierIdx")
      .on("pithyAuthVerifications")
      .column("identifier")
      .execute();
    await db.schema
      .createIndex("pithyAuthRotatedTokensFamilyIdIdx")
      .on("pithyAuthRotatedTokens")
      .column("familyId")
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyAuthRotatedTokensFamilyIdIdx").execute();
    await db.schema.dropIndex("pithyAuthVerificationsIdentifierIdx").execute();
    await db.schema.dropIndex("pithyAuthAccountsUserIdIdx").execute();
    await db.schema.dropIndex("pithyAuthSessionsDeviceIdIdx").execute();
    await db.schema.dropIndex("pithyAuthSessionsUserIdIdx").execute();

    await db.schema.dropTable("pithyAuthRotatedTokens").execute();
    await db.schema.dropTable("pithyAuthDevices").execute();
    await db.schema.dropTable("pithyAuthRateLimit").execute();
    await db.schema.dropTable("pithyAuthJwks").execute();
    await db.schema.dropTable("pithyAuthVerifications").execute();
    await db.schema.dropTable("pithyAuthAccounts").execute();
    await db.schema.dropTable("pithyAuthSessions").execute();
    await db.schema.dropTable("pithyAuthUsers").execute();
  },
};

/** The migration order for the auth namespace within the app database (library-before-app; auth is a wedge cap). */
export const AUTH_MIGRATION_ORDER = 300;
