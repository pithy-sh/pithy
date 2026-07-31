// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { TestersConfig } from "../config/config";
import { testersDatabase } from "../data/tables";
import { testers_0001_cohorts } from "../migrations/0001_cohorts";
import {
  confirmOptIn,
  createCohort,
  inviteMember,
  lapseMember,
  removeMember,
  requireMember,
  type WriteDeps,
} from "../roster/write";
import { registerTestersRoutes } from "./routes";

/**
 * The tester-facing routes against real D1.
 *
 * These four routes are the only unauthenticated surface this capability has, and `memberFor` is the
 * whole credential check behind them: unknown-token rejection, the replay block that stops a
 * withdrawal being undone, and the link-lifetime bound. None of it was executed by any test — the
 * contract test binds no `DB`, so no public handler ever ran, and the branches could all have been
 * deleted with a green suite. That is the gap this file closes.
 *
 * Real D1 rather than a fake, because every one of those branches is a decision about a row.
 */

const CONFIG = TestersConfig.parse({ baseUrl: "https://api.example.test" });
const DAY_ONE = new Date("2026-06-01T00:00:00.000Z");

let sequence = 0;
let audited: { action: string; outcome: string }[] = [];

function write(now: Date): WriteDeps {
  return { db: testersDatabase(env.DB), now, newId: () => `id-${++sequence}` };
}

/** The app, mounted with a clock a test can move. */
function makeApp(now: Date) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", null);
    c.set("emit", async (event: { action: string; outcome: string }) => {
      audited.push({ action: event.action, outcome: event.outcome });
    });
    c.set("log", noopLogger);
    await next();
  });
  registerTestersRoutes({ config: CONFIG, now: () => now, newId: () => `id-${++sequence}` })(app);
  return {
    /**
     * A request carrying the Worker `env`.
     *
     * Hono takes the env as `request`'s third argument, and omitting it is not a small mistake here:
     * `c.env.DB` would be undefined and every route would answer 500 `testers/not_configured` — a
     * uniform failure that would let this whole file pass as "everything is refused".
     */
    requestWithEnv: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
}

async function makeCohort(overrides: { storeOptInUrl?: string | null } = {}) {
  return createCohort(write(DAY_ONE), {
    name: `cohort-${++sequence}`,
    targetSize: 2,
    windowDays: 14,
    maxRosterSize: 10,
    targetPlatform: "android",
    // `??` would be wrong here: an explicit `null` is the case under test, and nullish coalescing
    // treats it as absent and hands back the default.
    storeOptInUrl:
      "storeOptInUrl" in overrides
        ? (overrides.storeOptInUrl ?? null)
        : "https://play.google.com/apps/testing/com.example.app",
    resetPolicy: "reset",
  });
}

/** A cohort with one invited tester, and that tester's token. */
async function makeMember(invitedAt = DAY_ONE, cohortOverrides: { storeOptInUrl?: string | null } = {}) {
  const cohort = await makeCohort(cohortOverrides);
  const { member } = await inviteMember(write(invitedAt), {
    cohortId: cohort.id,
    email: `tester-${++sequence}@example.test`,
    maxRosterSize: cohort.maxRosterSize,
  });
  return { cohort, member, token: member.optInToken };
}

/** How many days after day one. */
function day(n: number): Date {
  return new Date(DAY_ONE.getTime() + n * 86_400_000);
}

beforeEach(async () => {
  const untyped = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  for (const table of [
    "pithy_testers_cohort_snapshots",
    "pithy_testers_events",
    "pithy_testers_members",
    "pithy_testers_cohorts",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await testers_0001_cohorts.up(untyped);
  sequence = 0;
  audited = [];
});

describe("the token is the whole credential", () => {
  test("a token nobody holds is refused", async () => {
    const response = await makeApp(DAY_ONE).requestWithEnv(`/testers/confirm/${"a".repeat(43)}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("testers/invalid_token");
  });

  test("and a forgery is refused in exactly the same words as a miss", async () => {
    // The two must be indistinguishable. Anything else turns a public route into an oracle for which
    // testers exist on a cohort.
    const { member, token } = await makeMember();
    await removeMember(write(DAY_ONE), member.id);

    const miss = await makeApp(DAY_ONE).requestWithEnv(`/testers/confirm/${"z".repeat(43)}`);
    const stale = await makeApp(DAY_ONE).requestWithEnv(`/testers/confirm/${token}`);
    expect(stale.status).toBe(miss.status);
    expect(await stale.text()).toEqual(await miss.text());
  });

  test("the response never leaks the throw-site detail", async () => {
    // `detail` carries the member id on two of the three branches. The HTTP codec strips it; this is
    // the assertion that the strip is actually in the path these routes take.
    const { member, token } = await makeMember();
    await lapseMember(write(DAY_ONE), member.id);
    const body = await (await makeApp(DAY_ONE).requestWithEnv(`/testers/confirm/${token}`)).text();
    expect(body).not.toContain(member.id);
    expect(body).not.toContain("detail");
  });
});

describe("a tester who has left cannot be brought back by a link in their inbox", () => {
  test("a lapsed member's old token is refused", async () => {
    const { member, token } = await makeMember();
    await confirmOptIn(write(DAY_ONE), member.id);
    await lapseMember(write(day(1)), member.id);

    // Withdrawing rotates the token, so this token no longer resolves at all — and if it somehow did,
    // the state check refuses it. Both halves matter; this asserts the outcome they share.
    const response = await makeApp(day(2)).requestWithEnv(`/testers/opt-in/${token}`);
    expect(response.status).toBe(400);
  });

  test("a removed member's old token is refused too", async () => {
    const { member, token } = await makeMember();
    await removeMember(write(day(1)), member.id);
    expect((await makeApp(day(2)).requestWithEnv(`/testers/confirm/${token}`)).status).toBe(400);
  });
});

describe("the link lifetime", () => {
  test("a link inside the configured window works", async () => {
    const { token } = await makeMember();
    const response = await makeApp(day(CONFIG.optInLinkTtlDays - 1)).requestWithEnv(`/testers/confirm/${token}`);
    expect(response.status).toBe(200);
  });

  test("a link past it does not", async () => {
    // The bound the config field declares, actually enforced. Without this branch running, the field
    // was cross-validated at deploy and then read by nothing.
    const { token } = await makeMember();
    const response = await makeApp(day(CONFIG.optInLinkTtlDays + 1)).requestWithEnv(`/testers/confirm/${token}`);
    expect(response.status).toBe(400);
  });

  test("but withdrawing never expires, because the mail asking for a reply does not either", async () => {
    // The asymmetry this capability turns on. Nothing bounds outreach by `optInLinkTtlDays` — the daily
    // pass keeps nudging an opted-in tester, and `lastInvitedAt` only moves on a resend. Under a shared
    // TTL the unsubscribe link would die while the mail carrying it kept arriving.
    const { member, token } = await makeMember();
    await confirmOptIn(write(DAY_ONE), member.id);
    const far = day(CONFIG.optInLinkTtlDays + 60);

    expect((await makeApp(far).requestWithEnv(`/testers/confirm/${token}`)).status).toBe(400);
    expect((await makeApp(far).requestWithEnv(`/testers/opt-out/${token}`)).status).toBe(200);

    const withdrawn = await makeApp(far).requestWithEnv(`/testers/opt-out/${token}`, { method: "POST" });
    expect(withdrawn.status).toBe(200);
    expect((await requireMember(testersDatabase(env.DB), member.id)).state).toBe("lapsed");
  });
});

describe("withdrawing takes two steps", () => {
  test("the GET renders the form and changes nothing", async () => {
    // The reason the route is split. Mail clients prefetch links and scanners follow them; withdrawing
    // rotates the token, so a one-tap GET would be an irreversible action taken by a robot.
    const { member, token } = await makeMember();
    await confirmOptIn(write(DAY_ONE), member.id);

    const response = await makeApp(day(1)).requestWithEnv(`/testers/opt-out/${token}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<form method="post"');
    expect((await requireMember(testersDatabase(env.DB), member.id)).state).toBe("opted_in");
    expect(audited).toEqual([]);
  });

  test("the POST performs it, and audits it once", async () => {
    const { member, token } = await makeMember();
    await confirmOptIn(write(DAY_ONE), member.id);

    const response = await makeApp(day(1)).requestWithEnv(`/testers/opt-out/${token}`, { method: "POST" });
    expect(response.status).toBe(200);
    expect((await requireMember(testersDatabase(env.DB), member.id)).state).toBe("lapsed");
    expect(audited.filter((entry) => entry.action.includes("lapsed"))).toHaveLength(1);
  });

  test("and the token it rotates makes the second POST a dead link", async () => {
    // The dedup that matters is not a flag — it is that the credential is gone. An unauthenticated
    // route that could be replayed would let one leaked link write rows into the adopter's audit trail
    // without limit.
    const { member, token } = await makeMember();
    await confirmOptIn(write(DAY_ONE), member.id);
    await makeApp(day(1)).requestWithEnv(`/testers/opt-out/${token}`, { method: "POST" });
    audited = [];

    const replay = await makeApp(day(2)).requestWithEnv(`/testers/opt-out/${token}`, { method: "POST" });
    expect(replay.status).toBe(400);
    expect(audited).toEqual([]);
    expect((await requireMember(testersDatabase(env.DB), member.id)).state).toBe("lapsed");
  });
});

describe("the two-step join", () => {
  test("confirming records the intent and does not hand out the store link", async () => {
    // The whole reason there are two emails. The store's opt-in page only works once the developer has
    // added the address in Play Console by hand — no API does it — so showing the link here would send
    // a tester to a page that tells them the app is unavailable.
    const { member, token } = await makeMember();
    const response = await makeApp(day(1)).requestWithEnv(`/testers/confirm/${token}`);
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).not.toContain("play.google.com");
    expect((await requireMember(testersDatabase(env.DB), member.id)).state).toBe("accepted");
  });

  test("confirming twice is the same answer, and audits once", async () => {
    const { token } = await makeMember();
    await makeApp(day(1)).requestWithEnv(`/testers/confirm/${token}`);
    const first = audited.length;
    const again = await makeApp(day(2)).requestWithEnv(`/testers/confirm/${token}`);

    expect(again.status).toBe(200);
    expect(audited).toHaveLength(first);
  });

  test("the second link hands over the store page and marks them opted in", async () => {
    const { member, token } = await makeMember();
    await makeApp(day(1)).requestWithEnv(`/testers/confirm/${token}`);

    const response = await makeApp(day(2)).requestWithEnv(`/testers/opt-in/${token}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("play.google.com/apps/testing/com.example.app");
    expect((await requireMember(testersDatabase(env.DB), member.id)).state).toBe("opted_in");
  });

  test("a cohort with no store link says so rather than rendering a dead button", async () => {
    // Reachable in practice: `pithy testers create` allows the URL to be filled in later, and this is
    // what a tester sees if the developer never came back to it.
    const { token } = await makeMember(DAY_ONE, { storeOptInUrl: null });
    const response = await makeApp(day(1)).requestWithEnv(`/testers/opt-in/${token}`);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("<a href");
    expect(html).toContain("developer");
  });
});

describe("without a DB binding", () => {
  test("the failure names the missing binding rather than throwing a type error", async () => {
    const app = new Hono<PithyHonoEnv>();
    app.onError(pithyErrorHandler);
    app.use("*", async (c, next) => {
      c.set("auth", null);
      c.set("controlPlane", null);
      c.set("controlPlaneVerifier", null);
      c.set("emit", async () => {});
      c.set("log", noopLogger);
      await next();
    });
    registerTestersRoutes({ config: CONFIG })(app);

    const response = await app.request(`/testers/confirm/${"a".repeat(43)}`, undefined, {});
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Testers is not configured.");
  });
});
