// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/http/verify";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { TestersConfig } from "../config/config";
import { testersDatabase } from "../data/tables";
import { testers_0001_cohorts } from "../migrations/0001_cohorts";
import {
  closeCohort,
  createCohort,
  inviteMember,
  lapseMember,
  recordAccepted,
  recordNudge,
  type WriteDeps,
} from "../roster/write";
import { TESTERS_NUDGE_SEND_SCOPE, TESTERS_ROSTER_READ_SCOPE, TESTERS_ROSTER_WRITE_SCOPE } from "./guards";
import { registerTestersRoutes } from "./routes";

/**
 * The control-plane handlers, actually executed.
 *
 * `routeContract.test.ts` calls each of these with no credential and asserts 403, which proves the guard
 * runs and nothing else — every handler body was unreached. Nine independent guards inside them survived
 * mutation with the whole suite green: the project name bound, both copy bounds, resend's live-state
 * check, resend's cooldown, and the nudge batch cap among them. A guard nothing exercises is a comment.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const CONFIG = TestersConfig.parse({ baseUrl: "https://api.example.test" });
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const CONTROL_PLANE_ISSUER = "https://dashboard.example";
const CONTROL_PLANE_KEY_ID = "key-1";
const ENVIRONMENT = "prod";

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];
let sequence = 0;
let sent: { to: string; payload: Record<string, unknown> }[] = [];

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: CONTROL_PLANE_ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/control-plane",
    scopes: [...scopes],
    keys: [
      {
        keyId: CONTROL_PLANE_KEY_ID,
        publicKey: await exportPublicJwk(keys.publicKey),
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: new Date(NOW.getTime() - 86_400_000),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
}

function verifier(scopes: readonly ControlPlaneScope[]): ControlPlaneVerifier {
  const registered = connection(scopes);
  const spent = new Set<string>();
  return createControlPlaneVerifier({
    loadConnection: async (id) => {
      const row = await registered;
      return id === row.id ? row : null;
    },
    countConnections: async () => 1,
    replay: {
      async claim(jti) {
        if (spent.has(jti)) return false;
        spent.add(jti);
        return true;
      },
    },
    environment: ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => NOW,
  });
}

/** The app, with a live control-plane verifier and a capturing enqueue seam. */
function makeApp(scopes: readonly ControlPlaneScope[], config = CONFIG) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(scopes);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  registerTestersRoutes({
    config,
    now: () => NOW,
    newId: () => `id-${++sequence}`,
    enqueue: () => async (input) => {
      sent.push({ to: input.to, payload: input.payload as Record<string, unknown> });
      return { jobId: `job-${sent.length}`, status: "pending" };
    },
  })(app);
  return app;
}

/** A request carrying a freshly minted, body-bound control-plane token. */
async function call(
  app: Hono<PithyHonoEnv>,
  method: string,
  path: string,
  scope: ControlPlaneScope,
  body?: unknown,
): Promise<Response> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: CONTROL_PLANE_KEY_ID,
    issuer: CONTROL_PLANE_ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    body: payload === undefined ? undefined : new TextEncoder().encode(payload),
    now: () => NOW,
  });
  return app.request(
    `http://x${path}`,
    { method, headers: { "content-type": "application/json", [CONTROL_PLANE_HEADER]: token }, body: payload },
    { ...env, ENVIRONMENT },
  );
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

function write(now = NOW): WriteDeps {
  return { db: testersDatabase(env.DB), now, newId: () => `w-${++sequence}` };
}

async function cohortWith(overrides: { storeOptInUrl?: string | null } = {}) {
  return createCohort(write(), {
    name: `cohort-${++sequence}`,
    targetSize: 2,
    windowDays: 14,
    maxRosterSize: 10,
    targetPlatform: "android",
    storeOptInUrl:
      "storeOptInUrl" in overrides
        ? (overrides.storeOptInUrl ?? null)
        : "https://play.google.com/apps/testing/com.example.app",
    resetPolicy: "reset",
  });
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
  emitted = [];
  sent = [];
  sequence = 0;
});

describe("POST /invite", () => {
  test("adds a tester and audits it", async () => {
    const cohort = await cohortWith();
    const response = await call(
      makeApp([TESTERS_ROSTER_WRITE_SCOPE]),
      "POST",
      "/testers/invite",
      TESTERS_ROSTER_WRITE_SCOPE,
      {
        cohortId: cohort.id,
        email: "ada@example.test",
        sendInvitation: false,
      },
    );
    expect(response.status).toBe(200);
    expect(emitted.map((e) => e.action)).toContain("testers/member_invited");
  });

  test("refuses a name past the deployment's own bound", async () => {
    // The route schema has its own ceiling; this is the project's, which may be tighter. It could be
    // turned off entirely with the whole suite green.
    const tight = TestersConfig.parse({ baseUrl: "https://api.example.test", maxNameLength: 5 });
    const cohort = await cohortWith();
    const response = await call(
      makeApp([TESTERS_ROSTER_WRITE_SCOPE], tight),
      "POST",
      "/testers/invite",
      TESTERS_ROSTER_WRITE_SCOPE,
      { cohortId: cohort.id, email: "ada@example.test", name: "Ada Lovelace", sendInvitation: false },
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation/invalid_input");
  });

  test("refuses a tester already on the roster rather than resetting their history", async () => {
    const cohort = await cohortWith();
    await inviteMember(write(), { cohortId: cohort.id, email: "ada@example.test", maxRosterSize: 10 });
    const response = await call(
      makeApp([TESTERS_ROSTER_WRITE_SCOPE]),
      "POST",
      "/testers/invite",
      TESTERS_ROSTER_WRITE_SCOPE,
      {
        cohortId: cohort.id,
        email: "ada@example.test",
        sendInvitation: false,
      },
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("testers/already_on_roster");
  });
});

describe("POST /resend", () => {
  test("refuses a tester who has withdrawn", async () => {
    // Re-inviting somebody who opted out is the one message this capability must never send, and the
    // check could be turned off with the suite still green.
    const cohort = await cohortWith();
    const { member } = await inviteMember(write(), {
      cohortId: cohort.id,
      email: "ada@example.test",
      maxRosterSize: 10,
    });
    await lapseMember(write(), member.id);

    const response = await call(
      makeApp([TESTERS_ROSTER_WRITE_SCOPE]),
      "POST",
      "/testers/resend",
      TESTERS_ROSTER_WRITE_SCOPE,
      {
        cohortId: cohort.id,
        memberId: member.id,
      },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(sent).toEqual([]);
  });

  test("refuses a tester inside the cooldown", async () => {
    const cohort = await cohortWith();
    const { member } = await inviteMember(write(), {
      cohortId: cohort.id,
      email: "ada@example.test",
      maxRosterSize: 10,
    });
    await recordNudge(write(), { memberId: member.id, nudgeKind: "confirm", jobId: "j-1", copySource: "default" });

    const response = await call(
      makeApp([TESTERS_ROSTER_WRITE_SCOPE]),
      "POST",
      "/testers/resend",
      TESTERS_ROSTER_WRITE_SCOPE,
      {
        cohortId: cohort.id,
        memberId: member.id,
      },
    );
    expect(response.status).toBe(429);
    expect(await errorCode(response)).toBe("testers/nudge_cooldown");
    expect(sent).toEqual([]);
  });
});

describe("POST /nudge", () => {
  /** A cohort with one tester who has agreed and is waiting for the store link. */
  async function waitingTester(cohortOverrides: { storeOptInUrl?: string | null } = {}) {
    const cohort = await cohortWith(cohortOverrides);
    const { member } = await inviteMember(write(), {
      cohortId: cohort.id,
      email: `t-${++sequence}@example.test`,
      maxRosterSize: 10,
    });
    // `accepted`, not `opted_in`: this is the tester who has agreed and is waiting for the store link.
    // `confirmOptIn` is the *second* step, and a member already opted in is not due a store nudge.
    await recordAccepted(write(), member.id);
    return { cohort, member };
  }

  test("will not send the store link when there is no usable store link", async () => {
    // The daily pass guards this and calls the ungated version the worst failure the capability has:
    // the tester follows the link, `confirmOptIn` runs, the opt-in estimate climbs, and only then does
    // the page discover it has nowhere to send them. The dashboard's own send button was the exception.
    const cohort = await cohortWith({ storeOptInUrl: null });
    const { member } = await inviteMember(write(), {
      cohortId: cohort.id,
      email: "ada@example.test",
      maxRosterSize: 10,
    });
    await recordAccepted(write(), member.id);

    const response = await call(
      makeApp([TESTERS_NUDGE_SEND_SCOPE]),
      "POST",
      "/testers/nudge",
      TESTERS_NUDGE_SEND_SCOPE,
      {
        cohortId: cohort.id,
        kind: "store",
      },
    );
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("testers/not_configured");
    expect(sent).toEqual([]);
  });

  test("will not send the store link to somebody who has not agreed to test", async () => {
    // Naming an id selects; it does not override. An `invited` member is not on the Play tester list,
    // so the store page answers `App not available` and they conclude the app is broken.
    const cohort = await cohortWith();
    const { member } = await inviteMember(write(), {
      cohortId: cohort.id,
      email: "ada@example.test",
      maxRosterSize: 10,
    });

    const response = await call(
      makeApp([TESTERS_NUDGE_SEND_SCOPE]),
      "POST",
      "/testers/nudge",
      TESTERS_NUDGE_SEND_SCOPE,
      {
        cohortId: cohort.id,
        kind: "store",
        memberIds: [member.id],
      },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(sent).toEqual([]);
  });

  test("sends to a tester who is waiting for it", async () => {
    const { cohort } = await waitingTester();
    const response = await call(
      makeApp([TESTERS_NUDGE_SEND_SCOPE]),
      "POST",
      "/testers/nudge",
      TESTERS_NUDGE_SEND_SCOPE,
      {
        cohortId: cohort.id,
        kind: "store",
      },
    );
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.ctaUrl).toContain("/testers/opt-in/");
  });

  test("every nudge carries the tester's own way out", async () => {
    const { cohort } = await waitingTester();
    await call(makeApp([TESTERS_NUDGE_SEND_SCOPE]), "POST", "/testers/nudge", TESTERS_NUDGE_SEND_SCOPE, {
      cohortId: cohort.id,
      kind: "store",
    });
    expect(sent[0]?.payload.optOutUrl).toContain("/testers/opt-out/");
  });

  test("a dry run sends nothing and returns ids rather than addresses", async () => {
    // A caller holding only `testers:nudge:send` may mail the roster but was never granted permission to
    // read it, and a preview returning every eligible tester's email hands them exactly that.
    const { cohort, member } = await waitingTester();
    const response = await call(
      makeApp([TESTERS_NUDGE_SEND_SCOPE]),
      "POST",
      "/testers/nudge",
      TESTERS_NUDGE_SEND_SCOPE,
      {
        cohortId: cohort.id,
        kind: "store",
        dryRun: true,
      },
    );
    expect(response.status).toBe(200);
    expect(sent).toEqual([]);
    const body = await response.text();
    expect(body).toContain(member.id);
    expect(body).not.toContain(member.email);
  });

  test("refuses supplied copy past the deployment's bounds", async () => {
    const tight = TestersConfig.parse({
      baseUrl: "https://api.example.test",
      nudges: { maxSubjectLength: 5, maxBodyLength: 10 },
    });
    const { cohort } = await waitingTester();
    const response = await call(
      makeApp([TESTERS_NUDGE_SEND_SCOPE], tight),
      "POST",
      "/testers/nudge",
      TESTERS_NUDGE_SEND_SCOPE,
      { cohortId: cohort.id, kind: "store", subject: "A far longer subject than allowed" },
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("testers/copy_not_allowed");
    expect(sent).toEqual([]);
  });

  test("nothing sent is reported as a refusal, not as a success", async () => {
    // A response reporting an empty send as success renders in a dashboard as "sent" and the developer
    // never chases it.
    const cohort = await cohortWith();
    const response = await call(
      makeApp([TESTERS_NUDGE_SEND_SCOPE]),
      "POST",
      "/testers/nudge",
      TESTERS_NUDGE_SEND_SCOPE,
      {
        cohortId: cohort.id,
        kind: "inactive",
      },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(sent).toEqual([]);
  });
});

describe("GET /cohorts", () => {
  test("returns the cohort without the roster unless it is asked for", async () => {
    const cohort = await cohortWith();
    await inviteMember(write(), { cohortId: cohort.id, email: "ada@example.test", maxRosterSize: 10 });

    const response = await call(
      makeApp([TESTERS_ROSTER_READ_SCOPE]),
      "GET",
      "/testers/cohorts",
      TESTERS_ROSTER_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("ada@example.test");
    // The disclaimer is a required field, so it cannot be dropped by any code path.
    expect(body).toContain("divergenceRisks");
  });

  test("and with it when it is", async () => {
    const cohort = await cohortWith();
    await inviteMember(write(), { cohortId: cohort.id, email: "ada@example.test", maxRosterSize: 10 });

    const response = await call(
      makeApp([TESTERS_ROSTER_READ_SCOPE]),
      "GET",
      `/testers/cohorts?cohortId=${cohort.id}&members=true`,
      TESTERS_ROSTER_READ_SCOPE,
    );
    expect(await response.text()).toContain("ada@example.test");
  });
});

describe("scopes are not interchangeable", () => {
  test("a send credential cannot read the roster", async () => {
    // Read, write and send are three scopes precisely so a credential issued to read a roster cannot
    // also mail every person on it. The reverse must hold too.
    const response = await call(
      makeApp([TESTERS_NUDGE_SEND_SCOPE]),
      "GET",
      "/testers/cohorts",
      TESTERS_NUDGE_SEND_SCOPE,
    );
    expect(response.status).toBe(403);
  });

  test("a read credential cannot invite", async () => {
    const cohort = await cohortWith();
    const response = await call(
      makeApp([TESTERS_ROSTER_READ_SCOPE]),
      "POST",
      "/testers/invite",
      TESTERS_ROSTER_READ_SCOPE,
      {
        cohortId: cohort.id,
        email: "ada@example.test",
        sendInvitation: false,
      },
    );
    expect(response.status).toBe(403);
  });
});

describe("a closed cohort sends nothing further, which is what `close` promises", () => {
  /** `closedAt` was stamped by `close` and then read by exactly one filter — every other path carried on. */
  async function closedCohort() {
    const cohort = await cohortWith();
    const { member } = await inviteMember(write(), {
      cohortId: cohort.id,
      email: `t-${++sequence}@example.test`,
      maxRosterSize: 10,
    });
    await recordAccepted(write(), member.id);
    await closeCohort(write(), cohort.id);
    return { cohort, member };
  }

  test("cannot be invited onto", async () => {
    // There is no reopen, so a member added here would sit in permanent limbo: never chased, never
    // advanced past `invited`, and on the roster forever.
    const { cohort } = await closedCohort();
    const response = await call(
      makeApp([TESTERS_ROSTER_WRITE_SCOPE]),
      "POST",
      "/testers/invite",
      TESTERS_ROSTER_WRITE_SCOPE,
      { cohortId: cohort.id, email: "new@example.test", sendInvitation: true },
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("testers/cohort_closed");
    expect(sent).toEqual([]);
  });

  test("cannot be nudged", async () => {
    const { cohort } = await closedCohort();
    const response = await call(
      makeApp([TESTERS_NUDGE_SEND_SCOPE]),
      "POST",
      "/testers/nudge",
      TESTERS_NUDGE_SEND_SCOPE,
      {
        cohortId: cohort.id,
        kind: "store",
      },
    );
    expect(response.status).toBe(409);
    expect(sent).toEqual([]);
  });

  test("and its testers cannot be resent to", async () => {
    const { cohort, member } = await closedCohort();
    const response = await call(
      makeApp([TESTERS_ROSTER_WRITE_SCOPE]),
      "POST",
      "/testers/resend",
      TESTERS_ROSTER_WRITE_SCOPE,
      {
        cohortId: cohort.id,
        memberId: member.id,
      },
    );
    expect(response.status).toBe(409);
    expect(sent).toEqual([]);
  });

  test("but stays readable, because the history is the point of keeping it", async () => {
    const { cohort } = await closedCohort();
    const response = await call(
      makeApp([TESTERS_ROSTER_READ_SCOPE]),
      "GET",
      `/testers/cohorts?cohortId=${cohort.id}`,
      TESTERS_ROSTER_READ_SCOPE,
    );
    expect(response.status).toBe(200);
  });
});

describe("a write credential is not a read credential", () => {
  /**
   * The three scopes are separated so a management client may mail or manage a roster it was never
   * granted permission to read — the nudge dry-run says so itself and returns ids rather than
   * addresses. `resend` and `remove` echoed the address back on every call, so a caller holding only
   * write and send scopes could take the ids the dry-run hands out by design and turn them into a list
   * of real people's email addresses.
   */
  async function onRoster(email: string) {
    const cohort = await cohortWith();
    const { member } = await inviteMember(write(), { cohortId: cohort.id, email, maxRosterSize: 10 });
    return { cohort, member };
  }

  test("resend returns an id, not an address", async () => {
    const { cohort, member } = await onRoster("victim@example.test");
    const response = await call(
      makeApp([TESTERS_ROSTER_WRITE_SCOPE]),
      "POST",
      "/testers/resend",
      TESTERS_ROSTER_WRITE_SCOPE,
      { cohortId: cohort.id, memberId: member.id },
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(member.id);
    expect(body).not.toContain("victim@example.test");
  });

  test("remove returns an id and a state, not an address", async () => {
    const { cohort, member } = await onRoster("victim2@example.test");
    const response = await call(
      makeApp([TESTERS_ROSTER_WRITE_SCOPE]),
      "POST",
      "/testers/remove",
      TESTERS_ROSTER_WRITE_SCOPE,
      { cohortId: cohort.id, memberId: member.id },
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("removed");
    expect(body).not.toContain("victim2@example.test");
  });

  test("and the address still reaches the audit trail, which is where it belongs", async () => {
    const cohort = await cohortWith();
    await call(makeApp([TESTERS_ROSTER_WRITE_SCOPE]), "POST", "/testers/invite", TESTERS_ROSTER_WRITE_SCOPE, {
      cohortId: cohort.id,
      email: "audited@example.test",
      sendInvitation: false,
    });
    const invited = emitted.find((e) => e.action === "testers/member_invited");
    expect((invited?.metadata as { email?: string } | undefined)?.email).toBe("audited@example.test");
  });
});

describe("POST /invite will not re-mail somebody who withdrew", () => {
  test("the invitation is refused rather than reviving them", async () => {
    // `sendInvitation` defaults to true, so this path was one call away from mailing a tester who had
    // followed their own unsubscribe link and been told they would not hear from the test again.
    const cohort = await cohortWith();
    const { member } = await inviteMember(write(), {
      cohortId: cohort.id,
      email: "left@example.test",
      maxRosterSize: 10,
    });
    await lapseMember(write(), member.id);
    sent = [];

    const response = await call(
      makeApp([TESTERS_ROSTER_WRITE_SCOPE]),
      "POST",
      "/testers/invite",
      TESTERS_ROSTER_WRITE_SCOPE,
      { cohortId: cohort.id, email: "left@example.test" },
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("testers/withdrawn");
    expect(sent).toEqual([]);
  });
});
