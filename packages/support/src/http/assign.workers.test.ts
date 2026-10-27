// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { ActingOrganization } from "@pithy-sh/core/src/access/acting";
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
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { SupportConfig } from "../config/config";
import { resolveCategories } from "../data/categories";
import { UNCATEGORIZED } from "../data/enums";
import { SUPPORT_THREADS_TABLE, supportDatabase } from "../data/tables";
import { SupportThread } from "../data/thread";
import { SUPPORT_MIGRATIONS } from "../migrations/set";
import { resolveReplies } from "../reply/snippets";
import type { HandlerDeps } from "./handlers";
import { SupportAssignResponse, SupportThreadResponse, SupportThreadsResponse } from "./responses";
import { registerSupportRoutes } from "./routes";
import { SUPPORT_THREADS_ARCHIVE_SCOPE, SUPPORT_THREADS_ASSIGN_SCOPE, SUPPORT_THREADS_READ_SCOPE } from "./scopes";

/**
 * Assignment through both doors, actually executed: the control-plane route behind `support:threads:assign`
 * with a live verifier, and the staff session route behind support's assign power. What survives only here:
 * the scope refusal on a real token, the four columns a real request sets and clears, the history the read
 * returns, the listing filter over HTTP, and exactly one audit event per change — none for a no-op.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const ISSUER = "https://dashboard.example";
const KEY_ID = "key-1";
const ENVIRONMENT = "prod";
const THREAD_ID = "0195c1f0-0000-7000-8000-000000000001";
const OTHER_ID = "0195c1f0-0000-7000-8000-000000000002";
const STAFF = { readPower: "support:read", assignPower: "support:assign" };

const config = SupportConfig.parse({ staff: STAFF });
const db = supportDatabase(env.DB);

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];
let ids = 0;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "The hosted dashboard.",
    scopes: [...scopes],
    keys: [
      {
        keyId: KEY_ID,
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

function deps(c: { var: { emit: HandlerDeps["emit"] } }): HandlerDeps {
  return {
    db,
    d1: env.DB,
    config,
    categories: resolveCategories({}),
    snippets: resolveReplies({}),
    fts: false,
    peers: {},
    dispatchClassify: async () => false,
    emit: c.var.emit,
    log: noopLogger,
    newId: () => `id-${++ids}`,
    now: () => NOW,
  };
}

/** The app, with a live control-plane verifier, an optional signed-in staff user, and a capturing audit seam. */
function makeApp(options: {
  scopes?: readonly ControlPlaneScope[];
  user?: string;
  acting?: ActingOrganization | null;
  staff?: typeof STAFF;
}) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(options.scopes ?? []);
  app.use("*", async (c, next) => {
    c.set("auth", options.user ? { userId: options.user, sessionId: "s-1", scopes: [] } : null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("actingOrganization", async () => options.acting ?? null);
    c.set("sameOrigin", async (_c, next) => next());
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  registerSupportRoutes({ resolveDeps: async (c) => deps(c), staff: "staff" in options ? options.staff : STAFF })(app);
  return app;
}

async function signed(method: "GET" | "POST", path: string, scope: ControlPlaneScope, body?: unknown) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    ...(raw === undefined ? {} : { body: new TextEncoder().encode(raw) }),
    now: () => NOW,
  });
  return {
    request: new Request(`http://x${path}`, {
      method,
      headers: { [CONTROL_PLANE_HEADER]: token, ...(raw === undefined ? {} : { "content-type": "application/json" }) },
      ...(raw === undefined ? {} : { body: raw }),
    }),
  };
}

async function cp(
  app: Hono<PithyHonoEnv>,
  method: "GET" | "POST",
  path: string,
  scope: ControlPlaneScope,
  body?: unknown,
): Promise<Response> {
  const { request } = await signed(method, path, scope, body);
  return app.fetch(request, { ...env, ENVIRONMENT });
}

async function staffPost(app: Hono<PithyHonoEnv>, path: string, body: unknown): Promise<Response> {
  return app.request(
    `http://x${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { ...env, ENVIRONMENT },
  );
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "support", order: SUPPORT_MIGRATION_ORDER, migrations: SUPPORT_MIGRATIONS },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function seedThread(id: string, lastMessageAt: number): Promise<void> {
  const at = new Date(lastMessageAt);
  await db
    .insertInto(SUPPORT_THREADS_TABLE)
    .values(
      SupportThread.encode({
        id,
        channel: "email",
        inboxAddress: "support@help.example.com",
        subject: "Hi",
        fromAddress: "ada@example.com",
        fromName: null,
        senderAuthenticated: true,
        userId: null,
        category: UNCATEGORIZED,
        priority: "normal",
        sentiment: "neutral",
        confidence: null,
        model: null,
        classifiedAt: null,
        archived: false,
        archivedAt: null,
        archivedBy: null,
        messageCount: 0,
        firstMessageAt: at,
        lastMessageAt: at,
        createdAt: at,
        updatedAt: at,
      }),
    )
    .execute();
}

beforeEach(async () => {
  for (const table of [
    "pithy_support_search",
    "pithy_support_assignments",
    "pithy_support_thread_flags",
    "pithy_support_classifications",
    "pithy_support_attachments",
    "pithy_support_messages",
    "pithy_support_threads",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await runMigrations(env.DB, provider());
  await seedThread(THREAD_ID, NOW.getTime() - 1_000);
  await seedThread(OTHER_ID, NOW.getTime() - 2_000);
  emitted = [];
  ids = 0;
});

const GRACE = { ref: "member-7", name: "Grace Hopper" };
const LINUS = { ref: "member-9", name: "Linus" };
const supportEvents = () => emitted.filter((event) => event.action.startsWith("support/"));

describe("POST {base}/threads/:id/assign — the control-plane door", () => {
  test("refuses a connection that was not granted support:threads:assign", async () => {
    // Granted every other write, and still refused: holding one scope confers nothing about the rest.
    const app = makeApp({ scopes: [SUPPORT_THREADS_READ_SCOPE, SUPPORT_THREADS_ARCHIVE_SCOPE] });
    const response = await cp(app, "POST", `/support/threads/${THREAD_ID}/assign`, SUPPORT_THREADS_ASSIGN_SCOPE, {
      assignee: GRACE,
    });
    expect(response.status).toBe(403);
    expect(
      (await db.selectFrom(SUPPORT_THREADS_TABLE).select("assigneeRef").where("id", "=", THREAD_ID).executeTakeFirst())
        ?.assigneeRef ?? null,
    ).toBeNull();
    expect(supportEvents()).toEqual([]);
  });

  test("refuses a token minted for another scope, on a connection that holds this one", async () => {
    const app = makeApp({ scopes: [SUPPORT_THREADS_ASSIGN_SCOPE, SUPPORT_THREADS_READ_SCOPE] });
    const response = await cp(app, "POST", `/support/threads/${THREAD_ID}/assign`, SUPPORT_THREADS_READ_SCOPE, {
      assignee: GRACE,
    });
    expect(response.status).toBe(403);
  });

  test("assigns, hands on and unassigns, each with one audit event naming both sides and the note", async () => {
    const app = makeApp({ scopes: [SUPPORT_THREADS_ASSIGN_SCOPE] });
    const path = `/support/threads/${THREAD_ID}/assign`;

    const first = await cp(app, "POST", path, SUPPORT_THREADS_ASSIGN_SCOPE, { assignee: GRACE, note: "Billing." });
    expect(first.status).toBe(200);
    const body = SupportAssignResponse.parse(await first.json());
    expect(body.changed).toBe(true);
    expect(body.thread).toMatchObject({
      assigneeRef: "member-7",
      assigneeName: "Grace Hopper",
      assignedAt: NOW.toISOString(),
      assignedBy: "operator-1",
    });

    await cp(app, "POST", path, SUPPORT_THREADS_ASSIGN_SCOPE, { assignee: LINUS });
    const cleared = SupportAssignResponse.parse(
      await (await cp(app, "POST", path, SUPPORT_THREADS_ASSIGN_SCOPE, { assignee: null })).json(),
    );
    expect(cleared.thread).toMatchObject({ assigneeRef: null, assigneeName: null, assignedAt: null, assignedBy: null });

    expect(
      supportEvents().map((event) => ({
        action: event.action,
        actorType: event.actorType,
        actorId: event.actorId,
        resourceId: event.resourceId,
        metadata: event.metadata,
      })),
    ).toEqual([
      {
        action: "support/thread_assigned",
        actorType: "control-plane",
        actorId: "operator-1",
        resourceId: THREAD_ID,
        metadata: { previousAssignee: null, assignee: GRACE, note: "Billing." },
      },
      {
        action: "support/thread_assigned",
        actorType: "control-plane",
        actorId: "operator-1",
        resourceId: THREAD_ID,
        metadata: { previousAssignee: GRACE, assignee: LINUS, note: null },
      },
      {
        action: "support/thread_unassigned",
        actorType: "control-plane",
        actorId: "operator-1",
        resourceId: THREAD_ID,
        metadata: { previousAssignee: LINUS, assignee: null, note: null },
      },
    ]);
  });

  test("assigning the current assignee again changes nothing and emits nothing", async () => {
    const app = makeApp({ scopes: [SUPPORT_THREADS_ASSIGN_SCOPE] });
    const path = `/support/threads/${THREAD_ID}/assign`;
    await cp(app, "POST", path, SUPPORT_THREADS_ASSIGN_SCOPE, { assignee: GRACE });
    emitted = [];
    const again = SupportAssignResponse.parse(
      await (await cp(app, "POST", path, SUPPORT_THREADS_ASSIGN_SCOPE, { assignee: GRACE, note: "Again." })).json(),
    );
    expect(again.changed).toBe(false);
    expect(supportEvents()).toEqual([]);
    // Unassigning a thread nobody has is the same no-op.
    const nobody = SupportAssignResponse.parse(
      await (
        await cp(app, "POST", `/support/threads/${OTHER_ID}/assign`, SUPPORT_THREADS_ASSIGN_SCOPE, { assignee: null })
      ).json(),
    );
    expect(nobody.changed).toBe(false);
    expect(supportEvents()).toEqual([]);
  });

  test("refuses a ref spelled like the unassigned filter, and an unknown thread is a 404", async () => {
    const app = makeApp({ scopes: [SUPPORT_THREADS_ASSIGN_SCOPE] });
    const reserved = await cp(app, "POST", `/support/threads/${THREAD_ID}/assign`, SUPPORT_THREADS_ASSIGN_SCOPE, {
      assignee: { ref: "none", name: "Nobody" },
    });
    expect(reserved.status).toBe(400);
    const missing = await cp(
      app,
      "POST",
      "/support/threads/0195c1f0-0000-7000-8000-00000000dead/assign",
      SUPPORT_THREADS_ASSIGN_SCOPE,
      { assignee: GRACE },
    );
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("support/not_found");
  });
});

describe("the listing and the read carry the assignee", () => {
  test("assignee=<ref> and assignee=none filter the listing, and each row carries its assignee", async () => {
    const app = makeApp({ scopes: [SUPPORT_THREADS_ASSIGN_SCOPE, SUPPORT_THREADS_READ_SCOPE] });
    await cp(app, "POST", `/support/threads/${THREAD_ID}/assign`, SUPPORT_THREADS_ASSIGN_SCOPE, { assignee: GRACE });

    const list = async (query: string) =>
      SupportThreadsResponse.parse(
        await (await cp(app, "GET", `/support/threads${query}`, SUPPORT_THREADS_READ_SCOPE)).json(),
      ).threads;

    const all = await list("");
    expect(all.map((thread) => [thread.id, thread.assigneeRef])).toEqual([
      [THREAD_ID, "member-7"],
      [OTHER_ID, null],
    ]);
    expect((await list("?assignee=member-7")).map((thread) => thread.id)).toEqual([THREAD_ID]);
    expect((await list("?assignee=none")).map((thread) => thread.id)).toEqual([OTHER_ID]);
    expect(await list("?assignee=member-404")).toEqual([]);
  });

  test("the single read carries the assignee and every change, oldest first", async () => {
    const app = makeApp({ scopes: [SUPPORT_THREADS_ASSIGN_SCOPE, SUPPORT_THREADS_READ_SCOPE] });
    const path = `/support/threads/${THREAD_ID}/assign`;
    await cp(app, "POST", path, SUPPORT_THREADS_ASSIGN_SCOPE, { assignee: GRACE, note: "Billing." });
    await cp(app, "POST", path, SUPPORT_THREADS_ASSIGN_SCOPE, { assignee: LINUS });

    const read = SupportThreadResponse.parse(
      await (await cp(app, "GET", `/support/threads/${THREAD_ID}`, SUPPORT_THREADS_READ_SCOPE)).json(),
    );
    expect(read.thread).toMatchObject({ assigneeRef: "member-9", assigneeName: "Linus", assignedBy: "operator-1" });
    expect(
      read.assignments?.map((row) => [row.previousRef, row.assigneeRef, row.actorType, row.assignedBy, row.note]),
    ).toEqual([
      [null, "member-7", "control-plane", "operator-1", "Billing."],
      ["member-7", "member-9", "control-plane", "operator-1", null],
    ]);
  });
});

/** A signed-in user's acting organization, whose role holds exactly `powers`. */
function acting(...powers: string[]): ActingOrganization {
  return { organizationId: "org-staff", roleAllows: (power) => powers.includes(power) };
}

describe("POST {base}/staff/threads/:id/assign — the session door", () => {
  const path = `/support/staff/threads/${THREAD_ID}/assign`;

  test("refuses a signed-in user without support's assign power", async () => {
    for (const app of [
      makeApp({ user: "u-1", acting: null }),
      makeApp({ user: "u-1", acting: acting("support:read") }),
      makeApp({ user: "u-1", acting: acting("support:assign"), staff: undefined }),
    ]) {
      const response = await staffPost(app, path, { assignee: { ref: "u-1", name: "Ada" } });
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("auth/forbidden");
    }
    expect(supportEvents()).toEqual([]);
  });

  test("a staff member assigns themselves, and the thread and the trail say a user did it", async () => {
    const app = makeApp({ user: "u-1", acting: acting("support:assign") });
    const response = await staffPost(app, path, { assignee: { ref: "u-1", name: "Ada" } });
    expect(response.status).toBe(200);
    const body = SupportAssignResponse.parse(await response.json());
    expect(body.thread).toMatchObject({ assigneeRef: "u-1", assignedBy: "u-1" });
    expect(supportEvents()).toEqual([
      expect.objectContaining({
        action: "support/thread_assigned",
        actorType: "user",
        actorId: "u-1",
        metadata: { previousAssignee: null, assignee: { ref: "u-1", name: "Ada" }, note: null },
      }),
    ]);
  });

  test("a staff member hands the thread to another user", async () => {
    const app = makeApp({ user: "u-1", acting: acting("support:assign") });
    await staffPost(app, path, { assignee: { ref: "u-1", name: "Ada" } });
    const body = SupportAssignResponse.parse(
      await (await staffPost(app, path, { assignee: { ref: "u-2", name: "Grace" }, note: "Yours." })).json(),
    );
    expect(body.thread).toMatchObject({ assigneeRef: "u-2", assigneeName: "Grace", assignedBy: "u-1" });
  });
});
