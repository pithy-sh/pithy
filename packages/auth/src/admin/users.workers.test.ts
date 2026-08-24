// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { MAX_BOUND_PARAMETERS } from "@pithy-sh/core/src/data/boundParameters";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { CamelCasePlugin, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { beforeEach, describe, expect, test } from "vitest";
import { Session, User } from "../data/betterAuth";
import { Device } from "../data/device";
import { type AuthDatabase, type AuthTables, authDatabase } from "../data/tables";
import { auth_0001_init } from "../migrations/0001_init";
import {
  findSessionById,
  getUser,
  getUsers,
  listDeviceRegistry,
  listUserDevices,
  listUserSessions,
  listUsers,
  MAX_USER_LOOKUP,
  USER_LOOKUP_FIXED_PARAMETERS,
  userProviders,
  userSessionTokens,
} from "./users";

/**
 * The admin reads against real D1 (Miniflare), because every property that matters here is a property
 * of SQLite rather than of the code around it.
 *
 * Two of them could not be tested any other way. The **keyset cursor** only holds its position when the
 * comparison SQLite performs matches the storage class the column actually holds — and the two auth
 * date representations differ, so a wrong one returns the wrong page instead of throwing. And the
 * **device tiebreak** only makes a position exact when it names `(userId, id)`, which only matters when
 * two users mint the same client-generated device id, which only a real table can demonstrate.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");

function db(): AuthDatabase {
  return authDatabase(env.DB);
}

/**
 * The same database, recording every statement it issues.
 *
 * "One query for twelve people" and "an empty list issues no query" are the whole point of the bulk
 * read, and neither is visible in a return value — a loop of twelve queries returns the same map. So
 * the statements are counted, along with how many parameters each bound, which is also what keeps the
 * cap honest: adding a `where` beside the `in (…)` list shows up here rather than in production.
 */
function recordingDb(statements: { sql: string; parameters: number }[]): AuthDatabase {
  return new Kysely<DatabaseSchema<AuthTables>>({
    dialect: new D1Dialect({ database: env.DB }),
    plugins: [new CamelCasePlugin()],
    log: (event) => {
      if (event.level === "query") statements.push({ sql: event.query.sql, parameters: event.query.parameters.length });
    },
  }) as unknown as AuthDatabase;
}

/** A user row whose `createdAt` is `NOW` minus `ageMinutes` — so the newest-first order is stated, not implied. */
async function seedUser(id: string, email: string, ageMinutes: number, name = "Ada"): Promise<void> {
  const at = new Date(NOW.getTime() - ageMinutes * 60_000);
  await db()
    .insertInto("pithyAuthUsers")
    .values(
      User.encode({ id, name, email, emailVerified: true, image: null, locale: null, createdAt: at, updatedAt: at }),
    )
    .execute();
}

async function seedSession(id: string, userId: string, ageMinutes: number): Promise<void> {
  const at = new Date(NOW.getTime() - ageMinutes * 60_000);
  await db()
    .insertInto("pithyAuthSessions")
    .values(
      Session.encode({
        id,
        token: `token-${id}`,
        userId,
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
        ipAddress: "203.0.113.7",
        userAgent: "PithyTest/1.0",
        deviceId: null,
        familyId: null,
      }),
    )
    .execute();
}

async function seedDevice(id: string, userId: string, ageMinutes: number): Promise<void> {
  const at = new Date(NOW.getTime() - ageMinutes * 60_000);
  await db()
    .insertInto("pithyAuthDevices")
    .values(
      Device.encode({
        id,
        userId,
        platform: "ios",
        name: "Ada's phone",
        model: null,
        osVersion: null,
        appVersion: null,
        pushToken: "apns-secret-token",
        lastIp: "203.0.113.7",
        lastSeenAt: at,
        createdAt: at,
      }),
    )
    .execute();
}

beforeEach(async () => {
  const untyped = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  for (const table of [
    "pithy_auth_accounts",
    "pithy_auth_devices",
    "pithy_auth_jwks",
    "pithy_auth_rate_limit",
    "pithy_auth_rotated_tokens",
    "pithy_auth_sessions",
    "pithy_auth_users",
    "pithy_auth_verifications",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await auth_0001_init.up(untyped);
});

describe("listUsers", () => {
  test("returns users newest first", async () => {
    await seedUser("u-old", "old@example.test", 300);
    await seedUser("u-new", "new@example.test", 1);
    await seedUser("u-mid", "mid@example.test", 100);

    const page = await listUsers(db());
    expect(page.items.map((u) => u.id)).toEqual(["u-new", "u-mid", "u-old"]);
    expect(page.nextCursor).toBeNull();
  });

  test("the cursor holds its position while rows are inserted above it", async () => {
    // The whole reason this is keyset and not `OFFSET`. Under an offset, a sign-up landing at the head
    // between the two requests pushes a row from page one onto page two — so the client sees it twice
    // and misses another by the same amount, silently.
    for (let i = 0; i < 4; i++) await seedUser(`u-${i}`, `u${i}@example.test`, (4 - i) * 10);

    const first = await listUsers(db(), { limit: 2 });
    expect(first.items.map((u) => u.id)).toEqual(["u-3", "u-2"]);
    expect(first.nextCursor).not.toBeNull();

    await seedUser("u-brandnew", "brandnew@example.test", 0);

    const second = await listUsers(db(), { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((u) => u.id)).toEqual(["u-1", "u-0"]);
  });

  test("two users created in the same millisecond do not straddle a page boundary", async () => {
    // The `id` half of the cursor. Without it, one of these is skipped or returned twice — and the
    // Better-Auth adapter writes ISO-8601 text at millisecond precision, so a collision is a real event
    // on a busy sign-up, not a contrived one.
    await seedUser("u-a", "a@example.test", 50);
    await seedUser("u-b", "b@example.test", 50);
    await seedUser("u-c", "c@example.test", 50);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await listUsers(db(), { limit: 1, cursor });
      seen.push(...result.items.map((u) => u.id));
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(["u-a", "u-b", "u-c"]);
  });

  test("a malformed cursor reads as a first page rather than an error", async () => {
    await seedUser("u-1", "one@example.test", 5);
    const page = await listUsers(db(), { cursor: "not-a-cursor" });
    expect(page.items.map((u) => u.id)).toEqual(["u-1"]);
  });

  test("search matches email and display name", async () => {
    await seedUser("u-1", "ada@example.test", 10, "Ada Lovelace");
    await seedUser("u-2", "grace@example.test", 20, "Grace Hopper");

    expect((await listUsers(db(), { search: "ada@" })).items.map((u) => u.id)).toEqual(["u-1"]);
    expect((await listUsers(db(), { search: "hopper" })).items.map((u) => u.id)).toEqual(["u-2"]);
  });

  test("an underscore in a search term is a literal, not a wildcard", async () => {
    // `_` matches any single character in SQL `LIKE`, and underscores are extremely common in email
    // addresses. Unescaped, a support agent searching for one person's address matches somebody else's
    // and acts on the wrong account — which on this surface means revoking a stranger's sessions.
    await seedUser("u-real", "first_last@example.test", 10);
    await seedUser("u-other", "firstxlast@example.test", 20);

    const hits = await listUsers(db(), { search: "first_last" });
    expect(hits.items.map((u) => u.id)).toEqual(["u-real"]);
  });

  test("a percent in a search term matches nothing rather than everything", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    expect((await listUsers(db(), { search: "%" })).items).toEqual([]);
  });

  test("the page size is clamped rather than obeyed", async () => {
    for (let i = 0; i < 5; i++) await seedUser(`u-${i}`, `u${i}@example.test`, i + 1);
    // Below the floor: a caller asking for zero gets a row, not an empty page that reads as the end.
    expect((await listUsers(db(), { limit: 0 })).items).toHaveLength(1);
  });
});

describe("getUser and userProviders", () => {
  test("getUser answers null for an id nothing matches", async () => {
    expect(await getUser(db(), "nobody")).toBeNull();
  });

  test("userProviders reports the slugs and never loads a provider token", async () => {
    // The strongest form of "never project an OAuth token": the columns are not selected, so no later
    // edit to a view function can leak one. This asserts the shape the query returns.
    await seedUser("u-1", "ada@example.test", 10);
    await db()
      .insertInto("pithyAuthAccounts")
      .values({
        id: "acct-1",
        accountId: "google-sub-1",
        providerId: "google",
        userId: "u-1",
        accessToken: "ya29.super-secret",
        refreshToken: "1//refresh-secret",
        idToken: "eyJ.id.token",
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: "openid email",
        password: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .execute();

    const providers = await userProviders(db(), "u-1");
    expect(providers).toEqual(["google"]);
    expect(JSON.stringify(providers)).not.toContain("ya29");
  });
});

describe("getUsers", () => {
  test("resolves a list of ids in one query, keyed by id", async () => {
    // The defect: an adopter holding a membership list did one `getUser` per person. What is asserted
    // here is the count of statements, because the map alone cannot tell the two implementations apart.
    await seedUser("u-1", "ada@example.test", 10, "Ada Lovelace");
    await seedUser("u-2", "grace@example.test", 20, "Grace Hopper");
    await seedUser("u-3", "kay@example.test", 30, "Kay Antonelli");

    const statements: { sql: string; parameters: number }[] = [];
    const people = await getUsers(recordingDb(statements), ["u-3", "u-1"]);

    expect([...people.keys()].sort()).toEqual(["u-1", "u-3"]);
    expect(people.get("u-1")?.name).toBe("Ada Lovelace");
    expect(people.get("u-3")?.email).toBe("kay@example.test");
    expect(statements).toHaveLength(1);
    expect(statements[0]?.parameters).toBe(2);
  });

  test("rows come through the User codec, so a date is a Date and a flag is a boolean", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    const user = (await getUsers(db(), ["u-1"])).get("u-1");
    expect(user?.createdAt).toBeInstanceOf(Date);
    expect(user?.createdAt.toISOString()).toBe(new Date(NOW.getTime() - 600_000).toISOString());
    expect(user?.emailVerified).toBe(true);
  });

  test("an id with no row is an absence, not an error", async () => {
    // A membership row can outlive the user it names. The roster has to render that gap rather than
    // fail the whole screen, so the missing id is simply not in the map.
    await seedUser("u-1", "ada@example.test", 10);
    const people = await getUsers(db(), ["u-1", "u-departed"]);
    expect(people.size).toBe(1);
    expect(people.has("u-departed")).toBe(false);
    expect(people.get("u-departed")).toBeUndefined();
  });

  test("duplicate ids collapse to one entry and one bound parameter", async () => {
    // Two memberships can name the same person. Binding them twice is a wider statement for no answer.
    await seedUser("u-1", "ada@example.test", 10);
    const statements: { sql: string; parameters: number }[] = [];
    const people = await getUsers(recordingDb(statements), ["u-1", "u-1", "u-1"]);
    expect(people.size).toBe(1);
    expect(statements[0]?.parameters).toBe(1);
  });

  test("an empty list issues no query at all", async () => {
    const statements: { sql: string; parameters: number }[] = [];
    const people = await getUsers(recordingDb(statements), []);
    expect(people.size).toBe(0);
    expect(statements).toEqual([]);
  });

  test("a full cap's worth of ids is one statement D1 accepts", async () => {
    // The cap is only right if the statement it permits actually runs: `createDatabase` refuses a
    // statement over D1's ceiling, so a cap set one too high would fail here rather than in the docs.
    await seedUser("u-0", "ada@example.test", 10);
    const ids = ["u-0", ...Array.from({ length: MAX_USER_LOOKUP - 1 }, (_, i) => `u-missing-${i}`)];

    const statements: { sql: string; parameters: number }[] = [];
    const people = await getUsers(recordingDb(statements), ids);

    expect(people.size).toBe(1);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.parameters).toBe(MAX_USER_LOOKUP);
  });

  test("past the cap it refuses, naming the cap, and issues nothing", async () => {
    // Never a truncation: quietly answering for 100 of somebody's 140 members is a wrong roster
    // presented as a right one.
    const ids = Array.from({ length: MAX_USER_LOOKUP + 1 }, (_, i) => `u-${i}`);
    const statements: { sql: string; parameters: number }[] = [];

    const failure = await getUsers(recordingDb(statements), ids).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.code).toBe("validation/invalid_input");
    expect((failure as PithyError).message).toContain(String(MAX_USER_LOOKUP));
    expect(statements).toEqual([]);
  });

  test("the cap counts distinct ids, because duplicates never reach the statement", async () => {
    await seedUser("u-1", "ada@example.test", 10);
    await seedUser("u-2", "grace@example.test", 20);
    const repeated = Array.from({ length: MAX_USER_LOOKUP * 3 }, (_, i) => (i % 2 === 0 ? "u-1" : "u-2"));

    const people = await getUsers(db(), repeated);
    expect([...people.keys()].sort()).toEqual(["u-1", "u-2"]);
  });

  test("the cap admits a whole page of ids, and stays under D1's ceiling", async () => {
    // Both halves of the number. A caller's ids come from a page of their own, so a cap below
    // `MAX_PAGE_SIZE` would refuse the largest page the kit itself hands out; and the statement binds
    // one parameter per id plus `USER_LOOKUP_FIXED_PARAMETERS`, which has to fit what D1 takes.
    expect(MAX_USER_LOOKUP).toBeGreaterThanOrEqual(MAX_PAGE_SIZE);
    expect(MAX_USER_LOOKUP + USER_LOOKUP_FIXED_PARAMETERS).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
  });
});

describe("a user's sessions and devices are bounded", () => {
  test("listUserSessions reports truncation rather than returning everything", async () => {
    for (let i = 0; i < 4; i++) await seedSession(`s-${i}`, "u-1", i + 1);
    const bounded = await listUserSessions(db(), "u-1", 2);
    expect(bounded.items.map((s) => s.id)).toEqual(["s-0", "s-1"]);
    expect(bounded.truncated).toBe(true);

    const whole = await listUserSessions(db(), "u-1", 10);
    expect(whole.items).toHaveLength(4);
    expect(whole.truncated).toBe(false);
  });

  test("listUserDevices does too — a device id is client-minted, so the count is not the adopter's choice", async () => {
    for (let i = 0; i < 3; i++) await seedDevice(`d-${i}`, "u-1", i + 1);
    const bounded = await listUserDevices(db(), "u-1", 1);
    expect(bounded.items.map((d) => d.id)).toEqual(["d-0"]);
    expect(bounded.truncated).toBe(true);
  });

  test("neither reads across users", async () => {
    await seedSession("s-mine", "u-1", 1);
    await seedSession("s-theirs", "u-2", 1);
    await seedDevice("d-mine", "u-1", 1);
    await seedDevice("d-theirs", "u-2", 1);

    expect((await listUserSessions(db(), "u-1", 10)).items.map((s) => s.id)).toEqual(["s-mine"]);
    expect((await listUserDevices(db(), "u-1", 10)).items.map((d) => d.id)).toEqual(["d-mine"]);
  });
});

describe("listDeviceRegistry", () => {
  test("walks the fleet most-recently-seen first, and filters by user and platform", async () => {
    await seedDevice("d-1", "u-1", 30);
    await seedDevice("d-2", "u-2", 5);
    await seedDevice("d-3", "u-1", 60);

    expect((await listDeviceRegistry(db())).items.map((d) => d.id)).toEqual(["d-2", "d-1", "d-3"]);
    expect((await listDeviceRegistry(db(), { userId: "u-1" })).items.map((d) => d.id)).toEqual(["d-1", "d-3"]);
    expect((await listDeviceRegistry(db(), { platform: "android" })).items).toEqual([]);
  });

  test("two users sharing a device id are both returned, one per page", async () => {
    // The composite tiebreak, which is the whole reason the cursor's `id` is a `(userId, id)` pair.
    // `pithy_auth_devices` is keyed `(userId, id)` because the id is client-generated — so a cursor
    // tiebreaking on `id` alone does not name a unique row, and one of these two would be skipped.
    await seedDevice("same-device-id", "u-1", 10);
    await seedDevice("same-device-id", "u-2", 10);

    const first = await listDeviceRegistry(db(), { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await listDeviceRegistry(db(), { limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect([first.items[0]?.userId, second.items[0]?.userId].sort()).toEqual(["u-1", "u-2"]);
  });

  test("the cursor pages a ms-epoch column, not an ISO one", async () => {
    // `pithy_auth_devices.lastSeenAt` is a number while every Better-Auth date is text. Building this
    // cursor from the wrong representation does not throw — SQLite compares across storage classes and
    // quietly returns nothing — so the failure this catches is an empty second page, not an error.
    for (let i = 0; i < 4; i++) await seedDevice(`d-${i}`, "u-1", (4 - i) * 10);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await listDeviceRegistry(db(), { limit: 2, cursor });
      seen.push(...result.items.map((d) => d.id));
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(["d-3", "d-2", "d-1", "d-0"]);
  });
});

describe("the revocation lookups", () => {
  test("findSessionById returns the token the adapter delete keys on, or null", async () => {
    await seedSession("s-1", "u-1", 1);
    expect(await findSessionById(db(), "s-1")).toEqual({ id: "s-1", token: "token-s-1", userId: "u-1" });
    expect(await findSessionById(db(), "s-missing")).toBeNull();
  });

  test("userSessionTokens returns only that user's tokens", async () => {
    await seedSession("s-1", "u-1", 1);
    await seedSession("s-2", "u-1", 2);
    await seedSession("s-3", "u-2", 1);
    expect((await userSessionTokens(db(), "u-1")).sort()).toEqual(["token-s-1", "token-s-2"]);
    expect(await userSessionTokens(db(), "nobody")).toEqual([]);
  });
});
