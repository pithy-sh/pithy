// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../data/db";
import { CONTROL_PLANE_REPLAYS_TABLE, controlPlaneDatabase } from "../data/tables";
import { controlplane_0001_init } from "../migrations/0001_init";
import { d1ReplayGuard } from "./d1Guard";

/**
 * The D1 guard against real D1 in workerd. The claim's whole value is a property of the storage engine —
 * that a primary key decides which of N concurrent inserts wins — so a mocked database would assert
 * nothing worth asserting here.
 */

const TTL_SECONDS = 180;
const CONNECTION = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const raw = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

/** A clock the test steps by hand, so expiry is exercised without waiting for it. */
function fixedClock(start: string) {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at),
    advanceSeconds: (seconds: number) => {
      at += seconds * 1000;
    },
  };
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  await controlplane_0001_init.up(raw());
});

describe("d1ReplayGuard", () => {
  test("the first claim wins and the second is refused — the token is spendable exactly once", async () => {
    const clock = fixedClock("2026-02-01T09:30:00.000Z");
    const guard = d1ReplayGuard(controlPlaneDatabase(env.DB), { now: clock.now, ttlSeconds: TTL_SECONDS });

    expect(await guard.claim("cpt_once", CONNECTION)).toBe(true);
    expect(await guard.claim("cpt_once", CONNECTION)).toBe(false);
  });

  test("a replay presented by a different connection is refused too", async () => {
    const clock = fixedClock("2026-02-01T09:30:00.000Z");
    const guard = d1ReplayGuard(controlPlaneDatabase(env.DB), { now: clock.now, ttlSeconds: TTL_SECONDS });

    expect(await guard.claim("cpt_stolen", "connection-a")).toBe(true);
    // The jti alone is the key. Scoping uniqueness per connection would make a captured token spendable
    // again against any other connection, which is the exact thing the guard denies.
    expect(await guard.claim("cpt_stolen", "connection-b")).toBe(false);
  });

  test("concurrent presentations of one token admit exactly one — the race the KV guard loses", async () => {
    const clock = fixedClock("2026-02-01T09:30:00.000Z");
    const db = controlPlaneDatabase(env.DB);

    // Eight guards over the same database, standing in for eight colocations reaching one D1. Every
    // claim is issued before any has resolved, so nothing is serialised by the test itself.
    const guards = Array.from({ length: 8 }, () => d1ReplayGuard(db, { now: clock.now, ttlSeconds: TTL_SECONDS }));
    const outcomes = await Promise.all(guards.map((guard) => guard.claim("cpt_concurrent", CONNECTION)));

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  test("a spent jti stays spent for the whole TTL, then prunes once nothing could still carry it", async () => {
    const clock = fixedClock("2026-02-01T09:30:00.000Z");
    const db = controlPlaneDatabase(env.DB);
    const guard = d1ReplayGuard(db, { now: clock.now, ttlSeconds: TTL_SECONDS });

    expect(await guard.claim("cpt_expiring", CONNECTION)).toBe(true);

    // One second short of the TTL the record must still refuse. Forgetting a jti while a token carrying
    // it could still be accepted is precisely the replay this exists to stop.
    clock.advanceSeconds(TTL_SECONDS - 1);
    expect(await guard.claim("cpt_expiring", CONNECTION)).toBe(false);

    // Past it, the row is dead — but nothing deletes it until a later successful claim prunes.
    clock.advanceSeconds(2);
    expect(await guard.claim("cpt_later", CONNECTION)).toBe(true);

    const remaining = await db.selectFrom(CONTROL_PLANE_REPLAYS_TABLE).select("jti").execute();
    expect(remaining.map((row) => row.jti)).toEqual(["cpt_later"]);
  });

  test("a refused claim prunes nothing — a replay loop cannot drive an unbounded delete", async () => {
    const clock = fixedClock("2026-02-01T09:30:00.000Z");
    const db = controlPlaneDatabase(env.DB);
    const guard = d1ReplayGuard(db, { now: clock.now, ttlSeconds: TTL_SECONDS });

    expect(await guard.claim("cpt_a", CONNECTION)).toBe(true);
    clock.advanceSeconds(TTL_SECONDS + 1);

    // `cpt_a` is now expired. A refused claim must leave it in place: pruning on every call would let an
    // attacker replaying one token repeatedly issue a DELETE per attempt.
    expect(await guard.claim("cpt_a", CONNECTION)).toBe(false);
    const remaining = await db.selectFrom(CONTROL_PLANE_REPLAYS_TABLE).select("jti").execute();
    expect(remaining.map((row) => row.jti)).toEqual(["cpt_a"]);
  });
});
