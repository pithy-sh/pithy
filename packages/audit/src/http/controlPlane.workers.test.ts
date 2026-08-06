// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { AuditConfig } from "../capability";
import { type AuditDatabase, auditDatabase } from "../data/tables";
import { audit_0001_init } from "../migrations/0001_init";
import { queryAuditEvents } from "../query";
import { recordAuditEvent } from "../recorder";
import { AUDIT_EVENT_DETAIL_READ_SCOPE, AUDIT_TRAIL_READ_SCOPE } from "./guards";
import { registerAuditRoutes } from "./routes";

/**
 * The control-plane handlers, actually executed.
 *
 * `routeContract.test.ts` calls each route with no credential and asserts 403, which proves the guard
 * runs and nothing else — every handler body is unreached there. What lives only here: the projection
 * that decides which columns a management client may see, the keyset pagination that decides whether a
 * client paging a live trail can silently miss a record, and the audit write that records the read.
 * Each of those could be deleted with that file still green.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const BASE = AuditConfig.parse({}).basePath;
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const CONTROL_PLANE_ISSUER = "https://dashboard.example";
const CONTROL_PLANE_KEY_ID = "key-1";
const ENVIRONMENT = "prod";

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];

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

/**
 * The app, with a live control-plane verifier and a capturing `emit`.
 *
 * `emit` captures rather than writing, so the assertions about *what a read discloses* are not fighting
 * the rows the read itself appends. That the seam reaches D1 at all is proven in
 * `capability.workers.test.ts`, through the real composition.
 */
function makeApp(scopes: readonly ControlPlaneScope[], basePath = BASE) {
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
  registerAuditRoutes({ basePath, database: () => auditDatabase(env.DB) })(app);
  return app;
}

/** A request carrying a freshly minted control-plane token. */
async function call(
  app: Hono<PithyHonoEnv>,
  path: string,
  scope: ControlPlaneScope,
  method = "GET",
): Promise<Response> {
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: CONTROL_PLANE_KEY_ID,
    issuer: CONTROL_PLANE_ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    now: () => NOW,
  });
  return app.request(
    `http://x${path}`,
    { method, headers: { [CONTROL_PLANE_HEADER]: token } },
    { ...env, ENVIRONMENT },
  );
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

/** Seed one event through the real recorder, so every column is written the way production writes it. */
async function seed(event: AuditEventInput, occurredAt: Date): Promise<void> {
  await recordAuditEvent(
    auditDatabase(env.DB) as AuditDatabase,
    { ...event, occurredAt },
    { origin: { project: "acme", environment: ENVIRONMENT, worker: "api", version: "build-7" } },
  );
}

/** Every seeded event, newest first, as the trail itself orders them. */
async function trail() {
  return queryAuditEvents(auditDatabase(env.DB));
}

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  await audit_0001_init.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);
  emitted = [];
});

describe("GET /audit/events", () => {
  test("returns the trail newest first, with the build that recorded each event", async () => {
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-1" }, new Date(1_000));
    await seed({ action: "auth/logout", outcome: "success", actorType: "user", actorId: "u-1" }, new Date(2_000));

    const response = await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${BASE}/events`, AUDIT_TRAIL_READ_SCOPE);
    expect(response.status).toBe(200);
    const body = await response.json<{ events: { action: string; version: string | null }[]; nextCursor: null }>();
    expect(body.events.map((e) => e.action)).toEqual(["auth/logout", "auth/login"]);
    // The point of the version column: which build recorded it, not merely that something did.
    expect(body.events[0]?.version).toBe("build-7");
    expect(body.nextCursor).toBeNull();
  });

  test("never discloses the IP, the user-agent, or the metadata bag", async () => {
    // The whole reason the detail read is a separate scope. A listing that leaked any of these would
    // make that grant decorative, and this is the assertion that keeps the projection deliberate — a
    // `SELECT *` handed straight to `c.json` passes every other test in this file.
    await seed(
      {
        action: "testers/member_invited",
        outcome: "success",
        actorType: "control-plane",
        ip: "203.0.113.9",
        userAgent: "Dashboard/1.0",
        metadata: { email: "ada@example.test" },
      },
      new Date(3_000),
    );

    const body = await (await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${BASE}/events`, AUDIT_TRAIL_READ_SCOPE)).text();
    expect(body).not.toContain("203.0.113.9");
    expect(body).not.toContain("Dashboard/1.0");
    expect(body).not.toContain("ada@example.test");
    expect(body).toContain("testers/member_invited");
  });

  test("never discloses the internal autoincrement id", async () => {
    // Its own schema says internal, never exposed: it is monotonic, so publishing it tells a client
    // how many events the project has recorded. The cursor carries it as an opaque position, which is
    // a different thing from offering it as a field.
    await seed({ action: "auth/login", outcome: "success", actorType: "user" }, new Date(1_000));
    const body = await (await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${BASE}/events`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: Record<string, unknown>[];
    }>();
    expect(body.events[0]).toBeDefined();
    expect(Object.keys(body.events[0] ?? {})).not.toContain("id");
  });

  test("filters by actor, action, and time range", async () => {
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-1" }, new Date(1_000));
    await seed({ action: "auth/login", outcome: "denied", actorType: "user", actorId: "u-2" }, new Date(2_000));
    await seed({ action: "secrets/rotated", outcome: "success", actorType: "system" }, new Date(3_000));

    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    const byActor = await (await call(app, `${BASE}/events?actorId=u-2`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { actorId: string }[];
    }>();
    expect(byActor.events.map((e) => e.actorId)).toEqual(["u-2"]);

    const byOutcome = await (await call(app, `${BASE}/events?outcome=denied`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { action: string }[];
    }>();
    expect(byOutcome.events).toHaveLength(1);

    const window = new Date(2_000).toISOString();
    const byTime = await (await call(app, `${BASE}/events?from=${window}&to=${window}`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { actorId: string }[];
    }>();
    expect(byTime.events.map((e) => e.actorId)).toEqual(["u-2"]);
  });

  test("refuses a page larger than the shared ceiling, and a bound that is not a time", async () => {
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    expect((await call(app, `${BASE}/events?limit=1000`, AUDIT_TRAIL_READ_SCOPE)).status).toBe(400);
    const bad = await call(app, `${BASE}/events?from=yesterday`, AUDIT_TRAIL_READ_SCOPE);
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("validation/invalid_input");
  });

  test("audits the read, with what was asked for and how much came back", async () => {
    // Reading the record of everybody else's actions is itself one. Core's guard records that the call
    // was allowed; only the handler knows the filter and the size of the answer, which is the
    // difference between "somebody opened a pane" and "something paged the whole trail".
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-1" }, new Date(1_000));
    await call(makeApp([AUDIT_TRAIL_READ_SCOPE]), `${BASE}/events?actorId=u-1`, AUDIT_TRAIL_READ_SCOPE);

    const read = emitted.find((event) => event.action === "audit/trail_read");
    expect(read?.actorType).toBe("control-plane");
    expect(read?.actorId).toBe("operator-1");
    const metadata = read?.metadata as { connectionId: string; returned: number; query: { actorId?: string } };
    expect(metadata.connectionId).toBe(CONNECTION_ID);
    expect(metadata.returned).toBe(1);
    expect(metadata.query.actorId).toBe("u-1");
  });
});

describe("paging a trail that is still being written", () => {
  /** Five events, one millisecond apart, newest last. */
  async function fiveEvents() {
    for (let index = 0; index < 5; index += 1) {
      await seed(
        { action: "auth/login", outcome: "success", actorType: "user", actorId: `u-${index}` },
        new Date(index),
      );
    }
  }

  test("a cursor resumes exactly where the previous page ended", async () => {
    await fiveEvents();
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);

    const first = await (await call(app, `${BASE}/events?limit=2`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { actorId: string }[];
      nextCursor: string;
    }>();
    expect(first.events.map((e) => e.actorId)).toEqual(["u-4", "u-3"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await (
      await call(app, `${BASE}/events?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, AUDIT_TRAIL_READ_SCOPE)
    ).json<{ events: { actorId: string }[]; nextCursor: string }>();
    expect(second.events.map((e) => e.actorId)).toEqual(["u-2", "u-1"]);

    const third = await (
      await call(app, `${BASE}/events?limit=2&cursor=${encodeURIComponent(second.nextCursor)}`, AUDIT_TRAIL_READ_SCOPE)
    ).json<{ events: { actorId: string }[]; nextCursor: string | null }>();
    expect(third.events.map((e) => e.actorId)).toEqual(["u-0"]);
    // Null without a count query — the over-fetched row is what answers "is there more".
    expect(third.nextCursor).toBeNull();
  });

  test("an event written mid-read is not a skipped record", async () => {
    // The failure `OFFSET` has and keyset does not. With `OFFSET 2`, a row inserted at the head between
    // the two requests pushes `u-2` off page one and onto page two, so the client sees `u-3` twice and
    // reads `u-2` never. On an audit trail that is a record silently missed, not a cosmetic glitch.
    await fiveEvents();
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);

    const first = await (await call(app, `${BASE}/events?limit=2`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { actorId: string }[];
      nextCursor: string;
    }>();
    await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: "u-new" }, new Date(99));

    const second = await (
      await call(app, `${BASE}/events?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, AUDIT_TRAIL_READ_SCOPE)
    ).json<{ events: { actorId: string }[] }>();
    const seen = [...first.events, ...second.events].map((e) => e.actorId);
    expect(seen).toEqual(["u-4", "u-3", "u-2", "u-1"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("two events recorded in the same millisecond both survive a page boundary", async () => {
    // The reason the cursor carries an id at all. Sorting on the timestamp alone leaves two rows sharing
    // an instant straddling the boundary, and one of them is dropped or repeated.
    for (const actor of ["a", "b", "c"]) {
      await seed({ action: "auth/login", outcome: "success", actorType: "user", actorId: actor }, new Date(5_000));
    }
    const app = makeApp([AUDIT_TRAIL_READ_SCOPE]);
    const first = await (await call(app, `${BASE}/events?limit=2`, AUDIT_TRAIL_READ_SCOPE)).json<{
      events: { actorId: string }[];
      nextCursor: string;
    }>();
    const second = await (
      await call(app, `${BASE}/events?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, AUDIT_TRAIL_READ_SCOPE)
    ).json<{ events: { actorId: string }[] }>();
    const seen = [...first.events, ...second.events].map((e) => e.actorId);
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });

  test("a malformed cursor is a first page, not a 500", async () => {
    // Cursors travel through URLs, get truncated by clients, and outlive deploys. Treating a bad one as
    // an error turns an ordinary client bug into a pane that never loads, and hands anyone probing the
    // endpoint a way to tell a parse failure from an empty result.
    await fiveEvents();
    const response = await call(
      makeApp([AUDIT_TRAIL_READ_SCOPE]),
      `${BASE}/events?limit=2&cursor=not-a-cursor`,
      AUDIT_TRAIL_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ events: { actorId: string }[] }>();
    expect(body.events.map((e) => e.actorId)).toEqual(["u-4", "u-3"]);
  });
});

describe("GET /audit/events/:eventId", () => {
  test("returns the one event in full — IP, user-agent, and metadata included", async () => {
    await seed(
      {
        action: "auth/login",
        outcome: "success",
        actorType: "user",
        actorId: "u-1",
        ip: "203.0.113.9",
        userAgent: "Dashboard/1.0",
        metadata: { reason: "magic_link" },
      },
      new Date(1_000),
    );
    const [event] = await trail();
    expect(event).toBeDefined();

    const response = await call(
      makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]),
      `${BASE}/events/${event?.eventId}`,
      AUDIT_EVENT_DETAIL_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      event: { ip: string; userAgent: string; metadata: { reason: string }; version: string };
    }>();
    expect(body.event.ip).toBe("203.0.113.9");
    expect(body.event.userAgent).toBe("Dashboard/1.0");
    expect(body.event.metadata.reason).toBe("magic_link");
    expect(body.event.version).toBe("build-7");
  });

  test("an id nobody recorded is a 404, and the miss is still audited", async () => {
    // Probing for ids must not be the one action on this surface that leaves no trace.
    const missing = "11111111-2222-4333-8444-555555555555";
    const response = await call(
      makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]),
      `${BASE}/events/${missing}`,
      AUDIT_EVENT_DETAIL_READ_SCOPE,
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("core/not_found");
    const read = emitted.find((event) => event.action === "audit/event_read");
    expect(read?.outcome).toBe("failure");
    expect(read?.resourceId).toBe(missing);
  });

  test("audits which event was read, by whom", async () => {
    await seed({ action: "auth/login", outcome: "success", actorType: "user" }, new Date(1_000));
    const [event] = await trail();
    await call(
      makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]),
      `${BASE}/events/${event?.eventId}`,
      AUDIT_EVENT_DETAIL_READ_SCOPE,
    );
    const read = emitted.find((entry) => entry.action === "audit/event_read");
    expect(read?.resourceId).toBe(event?.eventId);
    expect(read?.actorId).toBe("operator-1");
    expect(read?.outcome).toBe("success");
  });
});

describe("the two read scopes are not interchangeable", () => {
  test("a listing credential cannot read one event in full", async () => {
    // The split is the whole control: a credential issued to render a recent-activity pane must not
    // also resolve every client IP and metadata bag in the project.
    await seed({ action: "auth/login", outcome: "success", actorType: "user", ip: "203.0.113.9" }, new Date(1_000));
    const [event] = await trail();
    const response = await call(
      makeApp([AUDIT_TRAIL_READ_SCOPE]),
      `${BASE}/events/${event?.eventId}`,
      AUDIT_TRAIL_READ_SCOPE,
    );
    expect(response.status).toBe(403);
  });

  test("a detail credential cannot enumerate the trail", async () => {
    // The reverse, and it is what stops the detail scope from being a bulk-harvest grant: holding it
    // alone, there is no route that hands out the ids to resolve.
    const response = await call(
      makeApp([AUDIT_EVENT_DETAIL_READ_SCOPE]),
      `${BASE}/events`,
      AUDIT_EVENT_DETAIL_READ_SCOPE,
    );
    expect(response.status).toBe(403);
  });

  test("a connection granted neither reads nothing", async () => {
    const response = await call(makeApp([]), `${BASE}/events`, AUDIT_TRAIL_READ_SCOPE);
    expect(response.status).toBe(403);
  });
});
