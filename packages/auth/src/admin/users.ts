// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { decodeCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { type SqlBool, sql } from "kysely";
import { Session, User } from "../data/betterAuth";
import { Device, type DevicePlatform } from "../data/device";
import type { AuthDatabase } from "../data/tables";

/**
 * The reads a management dashboard's user panes resolve to, and the lookups its revocations need.
 *
 * Deliberately **not** under `src/http/`: nothing here knows about a request, a scope, or a caller, so
 * the projections that decide what a management client may see stay in one place (`http/adminRoutes.ts`)
 * and these stay directly testable against a real D1. Everything takes the shared {@link AuthDatabase},
 * so the Better-Auth-managed tables and Pithy's own device registry are read through the one Kysely
 * with `CamelCasePlugin` — query code never types a `pithy_auth_` name.
 *
 * ## Two date representations, and getting it wrong is silent
 *
 * The Better-Auth tables store dates as **ISO-8601 text** (`BetterAuthDate`); `pithy_auth_devices`
 * stores them as Pithy's house **ms-epoch numbers** (`SQLiteDate`). A cursor carries the sort column's
 * *stored* value, so the users cursor holds a string and the devices cursor holds a number. Handing
 * SQLite the other one does not throw — it compares across storage classes and quietly returns the
 * wrong page — so each cursor is built from the parsed row and converted back to the column's own
 * representation rather than copied from whatever the row object happened to hold.
 *
 * ## Everything is bounded, including the sub-lists
 *
 * A device id is client-generated (`x-pithy-device-id`), so a single user can mint as many device rows
 * as they like, and sessions accumulate per sign-in. Reading "this user's devices" unbounded would let
 * any end user decide how much work an admin pane does. Every list here takes a limit and over-fetches
 * by one to report whether there is more.
 */

/** One page of rows plus where the next one starts. `nextCursor` is null at the end of the list. */
export interface AdminPage<T> {
  /** The rows in this page, already decoded through their table schema. */
  items: T[];
  /** The opaque cursor the next request should send, or null when this was the last page. */
  nextCursor: string | null;
}

/** A bounded sub-list inside a single-user view, and whether the bound cut it short. */
export interface AdminSubList<T> {
  /** The rows, most recent first, at most the requested limit. */
  items: T[];
  /** True when more rows exist than the limit allowed — the pane should say so rather than imply a total. */
  truncated: boolean;
}

/**
 * The separator joining `(userId, id)` into the device cursor's single tiebreak.
 *
 * `pithy_auth_devices` has a **composite** primary key, because `id` is a client-generated device id
 * that is unique only per user. A cursor tiebreaking on `id` alone would therefore not name a unique
 * row, and two users who happened to mint the same device id would straddle a page boundary — one of
 * them skipped. A NUL byte is the separator because a user id is a Better-Auth UUID and cannot contain
 * one, so splitting on the first occurrence recovers the pair exactly however the device id is written.
 */
const DEVICE_KEY_SEPARATOR = "\u0000";

function deviceKey(userId: string, id: string): string {
  return `${userId}${DEVICE_KEY_SEPARATOR}${id}`;
}

function splitDeviceKey(key: string): { userId: string; id: string } | undefined {
  const at = key.indexOf(DEVICE_KEY_SEPARATOR);
  if (at < 0) return undefined;
  return { userId: key.slice(0, at), id: key.slice(at + 1) };
}

/**
 * Escape a caller's search term for a `LIKE` pattern.
 *
 * Without this a term containing `%` or `_` silently becomes a wildcard, so a support agent searching
 * for the very common `first_last@example.com` matches addresses that are not the one they typed and
 * acts on the wrong person. It is a correctness fix rather than an authorization one — a caller holding
 * `auth:users:read` may already list every user — which is why the bound on the term's length lives on
 * the request schema instead.
 */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** What a user listing may filter and page by. */
export interface ListUsersOptions {
  /** Free text matched against email and display name. Absent lists everyone, newest first. */
  search?: string;
  /** The previous page's `nextCursor`. A malformed one is a first page, never an error. */
  cursor?: string;
  /** How many rows to return, clamped into `[1, MAX_PAGE_SIZE]` by `pageLimit`. */
  limit?: number;
}

/**
 * Users, newest first, optionally filtered by a free-text term over email and display name.
 *
 * Keyset-paginated on `(createdAt, id)` — never an offset. The users table is written to constantly
 * while somebody is paging through it, and under `OFFSET` a sign-up at the head pushes a row from page
 * one onto page two, so a client paging through sees it twice and misses another by the same amount.
 *
 * The search is a substring `LIKE` over two columns and no index can serve it; the request schema bounds
 * the term and `pageLimit` bounds the page, which is what keeps the scan a bounded one.
 */
export async function listUsers(db: AuthDatabase, options: ListUsersOptions = {}): Promise<AdminPage<User>> {
  const limit = pageLimit(options.limit);
  let query = db
    .selectFrom("pithyAuthUsers")
    .selectAll()
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);

  const term = options.search?.trim();
  if (term) {
    const pattern = likePattern(term);
    // Raw SQL for this one predicate, because SQLite's `ESCAPE` clause is part of the `LIKE` operator
    // rather than of its right-hand operand, so there is no expression-builder form of it. Both column
    // names are already their physical (single-word) names, so `CamelCasePlugin` has nothing to do here.
    query = query.where(sql<SqlBool>`(email like ${pattern} escape '\\' or name like ${pattern} escape '\\')`);
  }

  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    // ISO-8601 text, because that is what the Better-Auth adapter wrote. Descending lexicographic order
    // over a fixed-width ISO-8601 string is descending chronological order, which is why this works.
    const at = String(cursor.sort);
    const id = String(cursor.id);
    query = query.where((eb) =>
      eb.or([eb("createdAt", "<", at), eb.and([eb("createdAt", "=", at), eb("id", "<", id)])]),
    );
  }

  const rows = await query.execute();
  return toPage(
    rows.map((row) => User.parse(row)),
    limit,
    (user) => ({ sort: user.createdAt.toISOString(), id: user.id }),
  );
}

/** One user, or null when no row carries that id. The 404 is the caller's decision, not this one's. */
export async function getUser(db: AuthDatabase, userId: string): Promise<User | null> {
  const row = await db.selectFrom("pithyAuthUsers").selectAll().where("id", "=", userId).executeTakeFirst();
  return row ? User.parse(row) : null;
}

/**
 * The provider slugs a user can sign in with — `["google"]`, `["google", "apple"]`, or empty for a
 * passwordless-only account.
 *
 * **Selects `providerId` and nothing else, and that is the security property rather than an
 * optimisation.** `pithy_auth_accounts` also holds the provider's `accessToken`, `refreshToken`, and
 * `idToken` — live credentials against a third party, on the user's behalf. Those must never reach a
 * management client, and the strongest way to guarantee it is for them never to be loaded: a projection
 * cannot leak a column that was not selected, however the view function is later edited.
 */
export async function userProviders(db: AuthDatabase, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("pithyAuthAccounts")
    .select("providerId")
    .where("userId", "=", userId)
    .orderBy("providerId", "asc")
    .execute();
  return [...new Set(rows.map((row) => row.providerId))];
}

/** A user's live sessions, newest first, bounded. */
export async function listUserSessions(
  db: AuthDatabase,
  userId: string,
  limit: number,
): Promise<AdminSubList<Session>> {
  const rows = await db
    .selectFrom("pithyAuthSessions")
    .selectAll()
    .where("userId", "=", userId)
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1)
    .execute();
  return {
    items: rows.slice(0, limit).map((row) => Session.parse(row)),
    truncated: rows.length > limit,
  };
}

/** A user's registered devices, most-recently-seen first, bounded. */
export async function listUserDevices(db: AuthDatabase, userId: string, limit: number): Promise<AdminSubList<Device>> {
  const rows = await db
    .selectFrom("pithyAuthDevices")
    .selectAll()
    .where("userId", "=", userId)
    .orderBy("lastSeenAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1)
    .execute();
  return {
    items: rows.slice(0, limit).map((row) => Device.parse(row)),
    truncated: rows.length > limit,
  };
}

/** What a device-registry listing may filter and page by. */
export interface ListDeviceRegistryOptions {
  /** Narrow to one user's devices. Absent reads the whole fleet, most-recently-seen first. */
  userId?: string;
  /** Narrow to one platform. Typed as the enum, so a filter the column cannot hold is a compile error. */
  platform?: DevicePlatform;
  /** The previous page's `nextCursor`. A malformed one is a first page, never an error. */
  cursor?: string;
  /** How many rows to return, clamped into `[1, MAX_PAGE_SIZE]` by `pageLimit`. */
  limit?: number;
}

/**
 * The device registry across users, most-recently-seen first.
 *
 * Keyset-paginated on `(lastSeenAt, userId, id)`. `lastSeenAt` is a **ms-epoch number** here, not the
 * ISO-8601 text the Better-Auth tables use — this is Pithy's own table, on Pithy's house codec.
 */
export async function listDeviceRegistry(
  db: AuthDatabase,
  options: ListDeviceRegistryOptions = {},
): Promise<AdminPage<Device>> {
  const limit = pageLimit(options.limit);
  let query = db
    .selectFrom("pithyAuthDevices")
    .selectAll()
    .orderBy("lastSeenAt", "desc")
    .orderBy("userId", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);

  if (options.userId) query = query.where("userId", "=", options.userId);
  if (options.platform) query = query.where("platform", "=", options.platform);

  const cursor = decodeCursor(options.cursor);
  const key = cursor ? splitDeviceKey(String(cursor.id)) : undefined;
  const at = cursor ? Number(cursor.sort) : Number.NaN;
  // A cursor whose sort value is not a number, or whose tiebreak is not a `(userId, id)` pair, is a
  // cursor from somewhere else. Same rule as a malformed one: it reads as a first page.
  if (key && Number.isFinite(at)) {
    query = query.where((eb) =>
      eb.or([
        eb("lastSeenAt", "<", at),
        eb.and([
          eb("lastSeenAt", "=", at),
          eb.or([eb("userId", "<", key.userId), eb.and([eb("userId", "=", key.userId), eb("id", "<", key.id)])]),
        ]),
      ]),
    );
  }

  const rows = await query.execute();
  return toPage(
    rows.map((row) => Device.parse(row)),
    limit,
    (device) => ({ sort: device.lastSeenAt.getTime(), id: deviceKey(device.userId, device.id) }),
  );
}

/**
 * The session a management client named, or null.
 *
 * Returns the session's **token** because that is what Better Auth's `internalAdapter.deleteSession`
 * keys on — a revocation must go through it so the adapter's own bookkeeping stays consistent, exactly
 * as the user-facing device revoke does. The token is a live credential and stops here: it is looked up
 * and handed to the delete, and no projection in `http/adminRoutes.ts` ever carries it out to a caller.
 */
export async function findSessionById(
  db: AuthDatabase,
  sessionId: string,
): Promise<{ id: string; token: string; userId: string } | null> {
  const row = await db
    .selectFrom("pithyAuthSessions")
    .select(["id", "token", "userId"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  return row ?? null;
}

/** Every live session token a user holds — the set a sign-out-everywhere has to revoke. */
export async function userSessionTokens(db: AuthDatabase, userId: string): Promise<string[]> {
  const rows = await db.selectFrom("pithyAuthSessions").select("token").where("userId", "=", userId).execute();
  return rows.map((row) => row.token);
}
