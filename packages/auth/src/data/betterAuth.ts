import { JsonDate, SQLiteBoolean } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The Better-Auth-managed tables, one Zod object per table.
 *
 * Better Auth owns the reads and writes to these via its Kysely adapter (which wraps our shared
 * Kysely + `CamelCasePlugin`, so it issues camelCase identifiers that map to the snake_case
 * `pithy_auth_*` columns our migration creates). These schemas are the table definitions of record:
 * they back the migration, document the model, and decode any direct read Pithy does. Columns are
 * column-exact to Better Auth 1.6.19's generated SQLite schema. Dates are ISO-8601 text
 * (`BetterAuthDate`), booleans are `0|1` (`SQLiteBoolean`) — matching Better Auth's on-disk
 * representation, not Pithy's ms-epoch house default. `z.input` is the SQLite row; `z.output` the
 * app shape.
 */

/**
 * Date codec for Better-Auth columns. On SQLite/D1 Better Auth's adapter serializes `date` fields with
 * `Date#toISOString()` — ISO-8601 **text**, not the ms-epoch number Pithy's house `SQLiteDate` assumes.
 * That on-disk shape is exactly core's `JsonDate` (Date ↔ ISO-8601 string), so this is an alias, named
 * for its use so the right codec is obvious at each Better-Auth column (`SQLiteDate` would mis-decode).
 */
const BetterAuthDate = JsonDate;

/** `pithy_auth_users` — one end user. Text/UUID id (anti-enumeration); email is unique. */
export const User = z
  .object({
    id: z.string().describe("Primary key. A random/UUID text id (not auto-increment) so users cannot be enumerated."),
    name: z.string().describe("The user's display name, supplied by the provider profile or at sign-up."),
    email: z
      .string()
      .describe("The user's email address. Unique across all users; the identity key for passwordless sign-in."),
    emailVerified: SQLiteBoolean.describe(
      "Whether the email has been verified. Stored as `0|1`; magic-link/OTP sign-in sets it true.",
    ),
    image: z.string().nullable().describe("URL of the user's avatar from a social profile, or null."),
    createdAt: BetterAuthDate.describe(
      "When the user record was created. ISO-8601 text in SQLite; a `Date` in app code.",
    ),
    updatedAt: BetterAuthDate.describe(
      "When the user record was last updated. ISO-8601 text in SQLite; a `Date` in app code.",
    ),
  })
  .describe("A user in `pithy_auth_users` — the canonical identity every session and account hangs off.");
export type User = z.output<typeof User>;

/** `pithy_auth_sessions` — one active session (the long-lived, bearer/cookie credential). */
export const Session = z
  .object({
    id: z.string().describe("Primary key. A random/UUID text id."),
    expiresAt: BetterAuthDate.describe(
      "When the session expires. Slides forward on use within `updateAge`. ISO-8601 text in SQLite.",
    ),
    token: z
      .string()
      .describe(
        "The opaque session token. Unique; presented as the cookie value or `Authorization: Bearer`. The refresh credential.",
      ),
    createdAt: BetterAuthDate.describe("When the session was created. ISO-8601 text in SQLite."),
    updatedAt: BetterAuthDate.describe("When the session was last refreshed. ISO-8601 text in SQLite."),
    ipAddress: z
      .string()
      .nullable()
      .describe(
        "The client IP at sign-in, for the device registry and `new sign-in from…` security signals. Nullable.",
      ),
    userAgent: z.string().nullable().describe("The client user-agent at sign-in. Nullable."),
    userId: z.string().describe("The owning user's id. Foreign key to `pithy_auth_users(id)`, ON DELETE CASCADE."),
    deviceId: z
      .string()
      .nullable()
      .describe(
        "The id of the `pithy_auth_devices` row this session is bound to (per-device sessions), or null for a device-less web login.",
      ),
  })
  .describe("A session in `pithy_auth_sessions` — a signed-in credential, optionally bound to a device.");
export type Session = z.output<typeof Session>;

/** `pithy_auth_accounts` — a credential/identity link for a user (one row per social provider). */
export const Account = z
  .object({
    id: z.string().describe("Primary key. A random/UUID text id."),
    accountId: z.string().describe("The provider's stable id for this user (e.g. the Google `sub` claim)."),
    providerId: z
      .string()
      .describe("The provider slug, e.g. `google`. Identifies which OAuth/credential provider this row links."),
    userId: z.string().describe("The owning user's id. Foreign key to `pithy_auth_users(id)`, ON DELETE CASCADE."),
    accessToken: z
      .string()
      .nullable()
      .describe("The provider OAuth access token, if granted. Never returned to clients. Nullable."),
    refreshToken: z
      .string()
      .nullable()
      .describe(
        "The provider OAuth refresh token, if granted (`accessType: offline`). Never returned to clients. Nullable.",
      ),
    idToken: z
      .string()
      .nullable()
      .describe("The provider OIDC id token from the last sign-in. Never returned to clients. Nullable."),
    accessTokenExpiresAt: BetterAuthDate.nullable().describe(
      "When the provider access token expires. ISO-8601 text in SQLite. Nullable.",
    ),
    refreshTokenExpiresAt: BetterAuthDate.nullable().describe(
      "When the provider refresh token expires. ISO-8601 text in SQLite. Nullable.",
    ),
    scope: z.string().nullable().describe("The OAuth scopes granted, space-delimited. Nullable."),
    password: z
      .string()
      .nullable()
      .describe("Unused — Pithy is passwordless-only, so this Better-Auth column is always null."),
    createdAt: BetterAuthDate.describe("When the account link was created. ISO-8601 text in SQLite."),
    updatedAt: BetterAuthDate.describe("When the account link was last updated. ISO-8601 text in SQLite."),
  })
  .describe("An account link in `pithy_auth_accounts` — a user's connection to a social/OAuth provider.");
export type Account = z.output<typeof Account>;

/** `pithy_auth_verifications` — short-lived tokens: magic-link, OTP, and OAuth PKCE/state. */
export const Verification = z
  .object({
    id: z.string().describe("Primary key. A random/UUID text id."),
    identifier: z
      .string()
      .describe(
        "What the value verifies — a namespaced email for OTP/magic-link, or the OAuth `state` for PKCE. Indexed.",
      ),
    value: z
      .string()
      .describe("The token, code, or serialized PKCE/state payload. Consumed atomically on first verify (single-use)."),
    expiresAt: BetterAuthDate.describe(
      "When the verification expires (5 min for magic-link/OTP, ~10 min for OAuth state). ISO-8601 text in SQLite.",
    ),
    createdAt: BetterAuthDate.describe("When the verification was created. ISO-8601 text in SQLite."),
    updatedAt: BetterAuthDate.describe("When the verification was last updated. ISO-8601 text in SQLite."),
  })
  .describe(
    "A verification record in `pithy_auth_verifications` — the store behind magic-link, OTP, and OAuth PKCE state.",
  );
export type Verification = z.output<typeof Verification>;

/** `pithy_auth_jwks` — the JWKS keypairs that sign and verify short-lived JWT access tokens. */
export const Jwks = z
  .object({
    id: z.string().describe("Primary key. A random/UUID text id, used as the JWT `kid`."),
    publicKey: z
      .string()
      .describe("The public key (JWK), published at `/jwks` so resource servers verify access tokens locally."),
    privateKey: z
      .string()
      .describe(
        "The private signing key, encrypted at rest with the Better-Auth secret (sourced from `@pithy-sh/secrets`). Never published.",
      ),
    createdAt: BetterAuthDate.describe("When the keypair was created. ISO-8601 text in SQLite."),
    expiresAt: BetterAuthDate.nullable().describe(
      "When the keypair is retired. Retired keys stay published through their grace window so in-flight tokens still verify. Nullable.",
    ),
  })
  .describe(
    "A signing keypair in `pithy_auth_jwks` — rotation keeps prior public keys published so issued tokens keep verifying.",
  );
export type Jwks = z.output<typeof Jwks>;

/** `pithy_auth_rate_limit` — Better Auth's database-backed rate-limit counters (per key, durable across isolates). */
export const RateLimit = z
  .object({
    id: z.string().describe("Primary key. A random/UUID text id."),
    key: z.string().describe("The rate-limit bucket key (path + client IP). Unique."),
    count: z.number().int().describe("The number of requests counted in the current window."),
    lastRequest: z
      .number()
      .int()
      .describe(
        "The ms-epoch timestamp of the most recent request in the window. A raw number, written by Better Auth's limiter.",
      ),
  })
  .describe(
    "A rate-limit counter in `pithy_auth_rate_limit` — durable per-isolate-safe throttling for the auth send/sign-in routes.",
  );
export type RateLimit = z.output<typeof RateLimit>;
