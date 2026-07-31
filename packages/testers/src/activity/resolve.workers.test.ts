// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { auth_0001_init } from "@pithy-sh/auth/src/migrations/0001_init";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { resolveActivity } from "./resolve";

/**
 * The auth join, against the real auth tables.
 *
 * `readActivityInto` was never executed with data by any test: every workers test stood up only the
 * four `pithy_testers_*` tables, so the query threw on a missing `pithy_auth_users` and the catch
 * swallowed it. The whole function body was dead in the suite — `return;` as its first statement left
 * everything green, and so did reintroducing each of the two bugs its own comments record as already
 * fixed once.
 *
 * That matters more than a coverage number. This module decides who is "dark", which drives the health
 * scores, the darkness histogram, the inactivity nudges and the early-warning signal the whole
 * capability is built to provide. A regression here reports a perfectly active cohort as entirely dark
 * and nothing catches it.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const SINCE = new Date("2026-06-03T00:00:00.000Z");
const ACTIVE_SINCE = new Date("2026-06-07T00:00:00.000Z");

const OPTIONS = { since: SINCE, activeSince: ACTIVE_SINCE, unreachable: new Set<string>() };

/** Insert a user, since the whole join keys on the address. */
async function user(id: string, email: string) {
  await env.DB.prepare(
    "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, id, email, NOW.toISOString(), NOW.toISOString())
    .run();
}

/** A session. `createdAt`/`updatedAt` are ISO text on this table — Better Auth's own encoding. */
async function session(id: string, userId: string, createdAt: Date, updatedAt: Date) {
  await env.DB.prepare(
    "insert into pithy_auth_sessions (id, expires_at, token, created_at, updated_at, user_id) values (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, NOW.toISOString(), `tok-${id}`, createdAt.toISOString(), updatedAt.toISOString(), userId)
    .run();
}

/** A device. This is a Pithy-owned table, so its dates are ms-epoch integers. */
async function device(id: string, userId: string, lastSeenAt: Date, platform = "android") {
  await env.DB.prepare(
    "insert into pithy_auth_devices (id, user_id, platform, last_seen_at, created_at) values (?, ?, ?, ?, ?)",
  )
    .bind(id, userId, platform, lastSeenAt.getTime(), lastSeenAt.getTime())
    .run();
}

beforeEach(async () => {
  const untyped = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  // Snake_case: `CamelCasePlugin` is what turns `pithyAuthUsers` into the real table name, and these
  // drops bypass Kysely.
  for (const table of [
    "pithy_auth_rotated_tokens",
    "pithy_auth_devices",
    "pithy_auth_rate_limit",
    "pithy_auth_jwks",
    "pithy_auth_verifications",
    "pithy_auth_accounts",
    "pithy_auth_sessions",
    "pithy_auth_users",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await auth_0001_init.up(untyped);
});

describe("an address that matches no user", () => {
  test("is unobservable and never linked, which is not the same as quiet", () => {
    // `never_linked` is deliberately distinct from `inactive`: there is no "since" for somebody who
    // never arrived, and rendering them as having gone quiet invents a date.
    return resolveActivity(env.DB, ["nobody@example.test"], OPTIONS).then((activity) => {
      const reading = activity.get("nobody@example.test");
      expect(reading?.observability).toBe("unobservable");
      expect(reading?.state).toBe("never_linked");
      expect(reading?.lastAuthenticatedAt).toBeNull();
      expect(reading?.userId).toBeNull();
    });
  });
});

describe("a matched user", () => {
  test("with a session inside the window is observed and active", async () => {
    await user("u1", "ada@example.test");
    await session("s1", "u1", new Date("2026-06-08T00:00:00.000Z"), new Date("2026-06-09T00:00:00.000Z"));

    const reading = (await resolveActivity(env.DB, ["ada@example.test"], OPTIONS)).get("ada@example.test");
    expect(reading?.observability).toBe("observed");
    expect(reading?.state).toBe("active");
    expect(reading?.sessionsInWindow).toBe(1);
    expect(reading?.lastAuthenticatedAt?.toISOString()).toBe("2026-06-09T00:00:00.000Z");
  });

  test("whose long-lived session is refreshed inside the window is the most engaged tester there is", async () => {
    // The bug this line's own comment records: bounding on `createdAt` excluded the session created
    // before the window and refreshed inside it every day since, and reported its owner as dark.
    await user("u1", "ada@example.test");
    await session("s1", "u1", new Date("2026-01-01T00:00:00.000Z"), new Date("2026-06-09T00:00:00.000Z"));

    const reading = (await resolveActivity(env.DB, ["ada@example.test"], OPTIONS)).get("ada@example.test");
    expect(reading?.sessionsInWindow).toBe(1);
    expect(reading?.state).toBe("active");
  });

  test("whose session went stale before the window is not counted in it", async () => {
    await user("u1", "ada@example.test");
    await session("s1", "u1", new Date("2026-01-01T00:00:00.000Z"), new Date("2026-05-01T00:00:00.000Z"));

    const reading = (await resolveActivity(env.DB, ["ada@example.test"], OPTIONS)).get("ada@example.test");
    expect(reading?.sessionsInWindow).toBe(0);
    // No session in the window and no device at all: nothing to see, rather than quiet.
    expect(reading?.observability).toBe("unobservable");
  });

  test("with a session before the active line is observed but inactive", async () => {
    await user("u1", "ada@example.test");
    await session("s1", "u1", new Date("2026-06-04T00:00:00.000Z"), new Date("2026-06-04T00:00:00.000Z"));

    const reading = (await resolveActivity(env.DB, ["ada@example.test"], OPTIONS)).get("ada@example.test");
    expect(reading?.state).toBe("inactive");
    expect(reading?.lastAuthenticatedAt?.toISOString()).toBe("2026-06-04T00:00:00.000Z");
  });

  test("with no session and no device is unobservable, not merely quiet", async () => {
    // A user row we can learn nothing from. Calling it `observed` would let a tester with zero signal
    // score as having gone a bit quiet, when the truth is we have never seen them use the app.
    await user("u1", "ada@example.test");
    const reading = (await resolveActivity(env.DB, ["ada@example.test"], OPTIONS)).get("ada@example.test");
    expect(reading?.observability).toBe("unobservable");
  });
});

describe("devices", () => {
  test("cover the tester whose session is refreshed off-device", async () => {
    await user("u1", "ada@example.test");
    await device("d1", "u1", new Date("2026-06-09T00:00:00.000Z"));

    const reading = (await resolveActivity(env.DB, ["ada@example.test"], OPTIONS)).get("ada@example.test");
    expect(reading?.observability).toBe("observed");
    expect(reading?.state).toBe("active");
    expect(reading?.devices).toHaveLength(1);
    expect(reading?.devices[0]?.platform).toBe("android");
  });

  test("and the most recent signal wins, whichever kind it is", async () => {
    await user("u1", "ada@example.test");
    await session("s1", "u1", new Date("2026-06-04T00:00:00.000Z"), new Date("2026-06-04T00:00:00.000Z"));
    await device("d1", "u1", new Date("2026-06-09T00:00:00.000Z"));

    const reading = (await resolveActivity(env.DB, ["ada@example.test"], OPTIONS)).get("ada@example.test");
    expect(reading?.lastAuthenticatedAt?.toISOString()).toBe("2026-06-09T00:00:00.000Z");
    expect(reading?.state).toBe("active");
  });

  test("are ordered most recently seen first", async () => {
    await user("u1", "ada@example.test");
    await device("old", "u1", new Date("2026-06-01T00:00:00.000Z"), "ios");
    await device("new", "u1", new Date("2026-06-09T00:00:00.000Z"), "android");

    const reading = (await resolveActivity(env.DB, ["ada@example.test"], OPTIONS)).get("ada@example.test");
    expect(reading?.devices.map((d) => d.platform)).toEqual(["android", "ios"]);
  });
});

describe("unreachable overrides whatever we can see", () => {
  test("a bounced address is reported unreachable even with a live session", async () => {
    // Delivery is not activity, but a tester we cannot mail is not a tester we can chase, and the
    // roster needs to say so rather than showing them as healthy and waiting.
    await user("u1", "ada@example.test");
    await session("s1", "u1", new Date("2026-06-09T00:00:00.000Z"), new Date("2026-06-09T00:00:00.000Z"));

    const reading = (
      await resolveActivity(env.DB, ["ada@example.test"], {
        ...OPTIONS,
        unreachable: new Set(["ada@example.test"]),
      })
    ).get("ada@example.test");
    expect(reading?.observability).toBe("unreachable");
    expect(reading?.state).toBe("unreachable");
  });
});

describe("addresses", () => {
  test("match case-insensitively, because an invite and a sign-up are typed by different people", async () => {
    await user("u1", "ada@example.test");
    await session("s1", "u1", new Date("2026-06-09T00:00:00.000Z"), new Date("2026-06-09T00:00:00.000Z"));

    const activity = await resolveActivity(env.DB, ["Ada@Example.Test"], OPTIONS);
    expect(activity.get("ada@example.test")?.observability).toBe("observed");
  });

  test("every requested address gets a reading, matched or not", async () => {
    await user("u1", "ada@example.test");
    const activity = await resolveActivity(env.DB, ["ada@example.test", "nobody@example.test"], OPTIONS);
    expect([...activity.keys()].sort()).toEqual(["ada@example.test", "nobody@example.test"]);
  });

  test("an empty request is an empty answer rather than a query", async () => {
    expect((await resolveActivity(env.DB, [], OPTIONS)).size).toBe(0);
  });
});
