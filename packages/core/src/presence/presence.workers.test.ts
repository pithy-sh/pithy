// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runInDurableObject } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import type { AuditEventInput } from "../audit/auditEvent";
import { defineCapability } from "../capability/capability";
import { ControlPlaneAuditActions } from "../controlPlane/audit/actions";
import { controlplane } from "../controlPlane/capability";
import { ControlPlaneConnection, type Ed25519PublicJwk } from "../controlPlane/data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "../controlPlane/data/tables";
import { ControlPlaneManifest } from "../controlPlane/discovery/adminRoute";
import { controlplane_0001_init } from "../controlPlane/migrations/0001_init";
import { controlplane_0002_management_origin } from "../controlPlane/migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "../controlPlane/migrations/0003_connection_principal";
import { MANIFEST_READ_SCOPE } from "../controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "../controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "../controlPlane/wire";
import { createBackend } from "../createBackend";
import { createDatabase } from "../data/db";
import { SUBPROTOCOL_HEADER } from "../http/subprotocol";
import { PRESENCE_MAX_FRAME_BYTES, PRESENCE_ROOMS_BINDING, type PresenceDeclaration } from "./declaration";
import { type PresenceParticipant, PresenceRoomServerFrame } from "./frames";
import { PresenceTicket } from "./http/responses";
import { PresenceAttachment } from "./room";
import { mintPresenceTicket, PRESENCE_TICKET_PROTOCOL_PREFIX } from "./ticket";

/**
 * **Presence rooms end to end, in workerd**: a real composed backend with the control-plane seam, a capability
 * declaring two room kinds, real tickets from both doors, and real sockets on the real `PresenceRoom`.
 *
 * Every JSON frame a socket receives is parsed with the published schema, and the parse must hand back exactly
 * what arrived, so a key the room sends without the schema fails here.
 */

const ENVIRONMENT = "production";
const ISSUER = "https://app.pithy.sh";
const CONNECTION_ID = "b6a1f0c2-3d4e-4f50-8a9b-0c1d2e3f4a5b";
const THREADS_READ = "support:threads:read";
const INBOX_READ = "support:inbox:read";
const TICKET_KEY = "presence-test-key";
const BINDINGS = { ...env, ENVIRONMENT, PRESENCE_TICKET_KEY: TICKET_KEY };

/** Who the session gate admits: records starting `open-`, named by the `x-name` header or for the user. */
const presence: PresenceDeclaration = {
  basePath: "/support",
  ticketKey: (bindings) => String(bindings.PRESENCE_TICKET_KEY ?? ""),
  rooms: [
    {
      kind: "support.thread",
      scope: THREADS_READ,
      activities: ["viewing", "replying"],
      maxParticipants: 3,
      session: (c, recordId) =>
        recordId.startsWith("open-") ? { name: c.req.header("x-name") ?? `User ${c.var.auth?.userId}` } : null,
    },
    { kind: "support.inbox", scope: INBOX_READ, activities: ["viewing"] },
  ],
};

/** The reads a room kind's scope is inherited from: the support capability's own admin routes. */
const support = defineCapability({
  name: "support",
  requiredBindings: [],
  adminRoutes: [
    { method: "GET", path: "/support/threads/:id", scope: THREADS_READ, kind: "reads", summary: "Read one thread." },
    { method: "GET", path: "/support/inbox", scope: INBOX_READ, kind: "reads", summary: "Read the inbox." },
  ],
  presence,
});

/** A stand-in for `@pithy-sh/auth`: the user is the `x-user` header, and every origin is trusted. */
const signedIn = defineCapability({
  name: "signedin",
  requiredBindings: [],
  middleware: [
    (app) => {
      app.use("*", async (c, next) => {
        const user = c.req.header("x-user");
        c.set("auth", user ? { userId: user, sessionId: "s1", scopes: [] } : null);
        c.set("sameOrigin", async (_c, gateNext) => {
          await gateNext();
        });
        await next();
      });
    },
  ],
});

/** `audit()`'s middleware in miniature: replace the no-op `emit` with a recorder, so the trail can be read. */
const recorded: AuditEventInput[] = [];
const recorder = defineCapability({
  name: "recorder",
  requiredBindings: [],
  middleware: [
    (app) => {
      app.use("*", async (c, next) => {
        c.set("emit", async (event: AuditEventInput) => {
          recorded.push(event);
        });
        await next();
      });
    },
  ],
});

/** The control-plane rows the trail holds, as action and the scope each names. */
function controlPlaneRows(): { action: string; required?: unknown; scope?: unknown }[] {
  return recorded
    .filter((event) => event.actorType === "control-plane")
    .map((event) => ({
      action: event.action,
      ...(event.metadata?.required !== undefined ? { required: event.metadata.required } : {}),
      ...(event.metadata?.scope !== undefined ? { scope: event.metadata.scope } : {}),
    }));
}

const backend = createBackend({ capabilities: [controlplane(), signedIn, recorder, support] });

let key: { keyId: string; privateKey: CryptoKey; publicKey: Ed25519PublicJwk };

async function connect(scopes: string[]): Promise<void> {
  const now = new Date();
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(
      ControlPlaneConnection.encode({
        id: CONNECTION_ID,
        environment: ENVIRONMENT,
        issuer: ISSUER,
        workerUrl: "https://api.acme.example",
        basePath: "/control-plane",
        managementOrigin: null,
        authorizedBy: "ada@example.com",
        actorKind: "dashboard",
        purpose: "Support triage.",
        scopes,
        keys: [
          {
            keyId: key.keyId,
            publicKey: key.publicKey,
            validFrom: new Date(Date.now() - 60_000),
            validUntil: null,
            revokedAt: null,
          },
        ],
        createdAt: now,
        updatedAt: now,
      }),
    )
    .execute();
}

beforeEach(async () => {
  recorded.length = 0;
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await controlplane_0001_init.up(db);
  await controlplane_0002_management_origin.up(db);
  await controlplane_0003_connection_principal.up(db);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  key = { keyId: "cpk_dash", privateKey: pair.privateKey, publicKey: await exportPublicJwk(pair.publicKey) };
});

/** A control-plane call, signed for `scope` over exactly this body. */
async function controlPlaneTicket(scope: string, body: unknown): Promise<Response> {
  const payload = JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: key.privateKey,
    keyId: key.keyId,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: "usr_operator",
    scope,
    body: new TextEncoder().encode(payload),
  });
  return backend.request(
    "http://worker.example/control-plane/presence/tickets",
    {
      method: "POST",
      headers: { [CONTROL_PLANE_HEADER]: token, "content-type": "application/json" },
      body: payload,
    },
    BINDINGS,
  );
}

/** A session call, as `user` when given, with the display name the gate passes through when given. */
async function sessionTicket(body: unknown, user?: string, name?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-user"] = user;
  if (name !== undefined) headers["x-name"] = name;
  return backend.request(
    "http://worker.example/support/presence/tickets",
    { method: "POST", headers, body: JSON.stringify(body) },
    BINDINGS,
  );
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

/** Every frame one socket received, in order, and a cursor over them: `next` hands back frames not yet read. */
interface Inbox {
  readonly frames: string[];
  next(count: number): Promise<string[]>;
}

function collect(ws: WebSocket): Inbox {
  const frames: string[] = [];
  const waiters: (() => void)[] = [];
  let read = 0;
  ws.addEventListener("message", (event) => {
    frames.push(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
    for (const wake of waiters.splice(0)) wake();
  });
  return {
    frames,
    async next(count) {
      const start = read;
      const target = read + count;
      while (frames.length < target) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`waited for ${count} frame(s)`)), 2000);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      read = target;
      return frames.slice(start, target);
    },
  };
}

/** Upgrade at a room's socket path, offering `protocols` verbatim. */
async function upgrade(path: string, protocols: string): Promise<Response> {
  return backend.request(
    `http://worker.example${path}`,
    { headers: { upgrade: "websocket", [SUBPROTOCOL_HEADER]: protocols } },
    BINDINGS,
  );
}

/** Open a socket with a minted ticket, and read its `init`. */
async function open(ticket: PresenceTicket) {
  const response = await upgrade(
    ticket.socketPath,
    `${ticket.protocol}, ${PRESENCE_TICKET_PROTOCOL_PREFIX}${ticket.ticket}`,
  );
  expect(response.status).toBe(101);
  expect(response.headers.get(SUBPROTOCOL_HEADER)).toBe("pithy.presence.v1");
  const ws = response.webSocket;
  if (!ws) throw new Error("no socket on the 101");
  const inbox = collect(ws);
  ws.accept();
  const [raw] = await inbox.next(1);
  const init = conforming(raw ?? "");
  if (init.type !== "init") throw new Error(`first frame was ${init.type}`);
  return { ws, inbox, init };
}

/** A JSON frame, held to the published schema. */
function conforming(raw: string): PresenceRoomServerFrame {
  const frame: unknown = JSON.parse(raw);
  expect(PresenceRoomServerFrame.parse(frame)).toEqual(frame);
  return frame as PresenceRoomServerFrame;
}

/** A session user's ticket into a thread. */
async function userTicket(user: string, recordId: string): Promise<PresenceTicket> {
  const response = await sessionTicket({ kind: "support.thread", recordId }, user);
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  expect(PresenceTicket.parse(body)).toEqual(body);
  return body as PresenceTicket;
}

/** A management client's ticket into a thread. */
async function agentTicket(recordId: string, ref = "agent-7", name = "Ada (dashboard)"): Promise<PresenceTicket> {
  const response = await controlPlaneTicket(THREADS_READ, {
    kind: "support.thread",
    recordId,
    participant: { ref, name },
  });
  expect(response.status).toBe(201);
  return PresenceTicket.parse(await response.json());
}

describe("POST /control-plane/presence/tickets", () => {
  test("mints a ticket into a declared room for a connection granted the kind's scope", async () => {
    await connect([MANIFEST_READ_SCOPE, THREADS_READ]);
    const ticket = await agentTicket("th-1");
    expect(ticket).toMatchObject({
      kind: "support.thread",
      recordId: "th-1",
      socketPath: "/support/presence/rooms/support.thread/th-1",
      protocol: "pithy.presence.v1",
    });
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    // Allowed under the room kind's scope, which the gate checked.
    expect(controlPlaneRows()).toEqual([{ action: ControlPlaneAuditActions.callAllowed, scope: THREADS_READ }]);
  });

  test("refuses a connection that was never granted the kind's scope", async () => {
    await connect([MANIFEST_READ_SCOPE]);
    const response = await controlPlaneTicket(THREADS_READ, {
      kind: "support.thread",
      recordId: "th-1",
      participant: { ref: "a", name: "A" },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
    // One denial naming the kind's scope, and no allowed row before it: the gate decided, as for every route.
    expect(controlPlaneRows()).toEqual([{ action: ControlPlaneAuditActions.callDenied, required: THREADS_READ }]);
  });

  test("refuses a token minted for a scope the connection holds but the kind does not need, audited once", async () => {
    await connect([MANIFEST_READ_SCOPE, THREADS_READ]);
    const response = await controlPlaneTicket(MANIFEST_READ_SCOPE, {
      kind: "support.thread",
      recordId: "th-1",
      participant: { ref: "a", name: "A" },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
    expect(controlPlaneRows()).toEqual([{ action: ControlPlaneAuditActions.callDenied, required: THREADS_READ }]);
  });

  test("refuses a token minted for another scope, even one the connection holds", async () => {
    await connect([MANIFEST_READ_SCOPE, THREADS_READ, INBOX_READ]);
    const response = await controlPlaneTicket(INBOX_READ, {
      kind: "support.thread",
      recordId: "th-1",
      participant: { ref: "a", name: "A" },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
  });

  test("refuses an undeclared room kind", async () => {
    await connect([MANIFEST_READ_SCOPE, THREADS_READ]);
    const response = await controlPlaneTicket(THREADS_READ, {
      kind: "support.macro",
      recordId: "th-1",
      participant: { ref: "a", name: "A" },
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("core/not_found");
  });

  test("refuses a caller with no credential before reading the body", async () => {
    const response = await backend.request(
      "http://worker.example/control-plane/presence/tickets",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      BINDINGS,
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("controlplane/invalid_credential");
  });
});

describe("POST {base}/presence/tickets", () => {
  test("mints a ticket for a signed-in user the capability's read permission admits", async () => {
    const ticket = await userTicket("u-1", "open-1");
    expect(ticket.socketPath).toBe("/support/presence/rooms/support.thread/open-1");
  });

  test("refuses a caller with no session", async () => {
    const response = await sessionTicket({ kind: "support.thread", recordId: "open-1" });
    expect(response.status).toBe(401);
  });

  test("refuses a session the capability's read permission does not admit", async () => {
    const response = await sessionTicket({ kind: "support.thread", recordId: "closed-1" }, "u-1");
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("auth/forbidden");
  });

  test("fits a gate's display name that is too long or blank, rather than failing the mint", async () => {
    const long = await sessionTicket({ kind: "support.thread", recordId: "open-20" }, "u-long", "L".repeat(200));
    expect(long.status).toBe(201);
    const blank = await sessionTicket({ kind: "support.thread", recordId: "open-20" }, "u-blank", "");
    expect(blank.status).toBe(201);

    const first = await open(PresenceTicket.parse(await long.json()));
    const second = await open(PresenceTicket.parse(await blank.json()));
    expect(second.init.participants.map((p) => [p.ref, p.name])).toEqual([
      ["u-long", "L".repeat(80)],
      ["u-blank", "u-blank"],
    ]);
    first.ws.close();
    second.ws.close();
  });

  test("refuses a kind that admits management clients only, and an undeclared kind", async () => {
    const inbox = await sessionTicket({ kind: "support.inbox", recordId: "open-1" }, "u-1");
    expect(inbox.status).toBe(403);
    const unknown = await sessionTicket({ kind: "support.macro", recordId: "open-1" }, "u-1");
    expect(unknown.status).toBe(404);
  });
});

/** Every D1 table, with how many rows it holds — what a write of any kind into any table would change. */
async function rowCounts(): Promise<Record<string, number>> {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of tables.results) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first<{ n: number }>();
    counts[name] = row?.n ?? 0;
  }
  return counts;
}

describe("the room socket", () => {
  test("negotiates pithy.presence.v1 and refuses an upgrade without a valid ticket", async () => {
    const path = "/support/presence/rooms/support.thread/open-2";
    const none = await upgrade(path, "pithy.presence.v1");
    expect(none.status).toBe(401);
    expect(await errorCode(none)).toBe("core/presence_ticket_invalid");

    const forged = await upgrade(path, `pithy.presence.v1, ${PRESENCE_TICKET_PROTOCOL_PREFIX}e30.AAAA`);
    expect(forged.status).toBe(401);

    // A ticket and no version is refused by the negotiation, not let through as unversioned.
    const ticket = await userTicket("u-1", "open-2");
    const unversioned = await upgrade(path, `${PRESENCE_TICKET_PROTOCOL_PREFIX}${ticket.ticket}`);
    expect(unversioned.status).toBe(400);
  });

  test("refuses a replayed ticket, an expired one, and one minted for another room", async () => {
    const ticket = await userTicket("u-1", "open-3");
    const first = await open(ticket);

    const replay = await upgrade(
      ticket.socketPath,
      `pithy.presence.v1, ${PRESENCE_TICKET_PROTOCOL_PREFIX}${ticket.ticket}`,
    );
    expect(replay.status).toBe(401);
    expect(await errorCode(replay)).toBe("core/presence_ticket_invalid");

    // Still spent once the socket that redeemed it has gone: the room remembers it until it would expire.
    first.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterClose = await upgrade(
      ticket.socketPath,
      `pithy.presence.v1, ${PRESENCE_TICKET_PROTOCOL_PREFIX}${ticket.ticket}`,
    );
    expect(afterClose.status).toBe(401);

    const stale = await mintPresenceTicket(
      { kind: "support.thread", recordId: "open-3", ref: "u-1", name: "U", origin: "session" },
      [TICKET_KEY],
      new Date(Date.now() - 61_000),
    );
    const expired = await upgrade(
      ticket.socketPath,
      `pithy.presence.v1, ${PRESENCE_TICKET_PROTOCOL_PREFIX}${stale.ticket}`,
    );
    expect(expired.status).toBe(401);

    const elsewhere = await userTicket("u-1", "open-4");
    const crossed = await upgrade(
      ticket.socketPath,
      `pithy.presence.v1, ${PRESENCE_TICKET_PROTOCOL_PREFIX}${elsewhere.ticket}`,
    );
    expect(crossed.status).toBe(401);
  });

  test("a ticket spent in a room that emptied stays spent once the next socket's room hibernates", async () => {
    const path = "/support/presence/rooms/support.thread/open-21";
    const offer = (ticket: PresenceTicket) => `pithy.presence.v1, ${PRESENCE_TICKET_PROTOCOL_PREFIX}${ticket.ticket}`;
    const spent = await userTicket("u-a", "open-21");
    const a = await open(spent);
    a.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await open(await userTicket("u-b", "open-21"));

    const ns = BINDINGS[PRESENCE_ROOMS_BINDING];
    const stub = ns.get(ns.idFromName("support.thread:open-21"));
    await runInDurableObject(stub, async (room, state) => {
      // The next socket's attachment carries the spent ticket, which outlives the room's memory.
      const [b] = state.getWebSockets().map((ws) => PresenceAttachment.parse(ws.deserializeAttachment()));
      expect(b?.spent.map((ticket) => ticket.exp)).toEqual([Math.floor(Date.parse(spent.expiresAt) / 1000)]);
      // A hibernation: the instance's memory is gone, the sockets and their attachments are not.
      (room as unknown as { remembered: unknown[] }).remembered = [];
    });
    const replay = await upgrade(path, offer(spent));
    expect(replay.status).toBe(401);
    expect(await errorCode(replay)).toBe("core/presence_ticket_invalid");
  });

  test("a room left empty with a spent ticket stays awake until that ticket expires, so it cannot forget it", async () => {
    const spent = await userTicket("u-a", "open-22");
    const a = await open(spent);
    a.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const ns = BINDINGS[PRESENCE_ROOMS_BINDING];
    const stub = ns.get(ns.idFromName("support.thread:open-22"));
    await runInDurableObject(stub, async (room, state) => {
      expect(state.getWebSockets()).toEqual([]);
      // A pending timer is what keeps a Durable Object with no socket from hibernating.
      const awake = (room as unknown as { awake: { until: number } | null }).awake;
      expect(awake?.until).toBe(Math.floor(Date.parse(spent.expiresAt) / 1000));
    });
  });

  test("a control-plane participant and a session participant see each other, each with its origin", async () => {
    await connect([MANIFEST_READ_SCOPE, THREADS_READ]);
    const agent = await open(await agentTicket("open-5"));
    expect(agent.init.participants).toHaveLength(1);
    const [self] = agent.init.participants as [PresenceParticipant];
    expect(self).toMatchObject({ id: agent.init.self, ref: "agent-7", origin: "control-plane", activity: "viewing" });

    const joined = agent.inbox.next(1);
    const user = await open(await userTicket("u-9", "open-5"));
    expect(user.init.participants.map((p) => [p.ref, p.origin, p.name])).toEqual([
      ["agent-7", "control-plane", "Ada (dashboard)"],
      ["u-9", "session", "User u-9"],
    ]);
    const [joinedRaw] = await joined;
    const frame = conforming(joinedRaw ?? "");
    expect(frame).toMatchObject({ type: "joined", participant: { ref: "u-9", origin: "session" } });
  });

  test("a join, an activity change and a leave reach every other socket, and a dropped socket is removed", async () => {
    const a = await open(await userTicket("u-a", "open-6"));
    const b = await open(await userTicket("u-b", "open-6"));
    await a.inbox.next(1); // b joined
    const c = await open(await userTicket("u-c", "open-6"));
    const [aJoin] = await a.inbox.next(1);
    const [bJoin] = await b.inbox.next(1);
    expect(conforming(aJoin ?? "")).toMatchObject({ type: "joined", participant: { id: c.init.self } });
    expect(conforming(bJoin ?? "")).toMatchObject({ type: "joined", participant: { id: c.init.self } });

    b.ws.send(JSON.stringify({ type: "set_activity", activity: "replying" }));
    const [aActivity] = await a.inbox.next(1);
    const [cActivity] = await c.inbox.next(1);
    for (const raw of [aActivity, cActivity]) {
      expect(conforming(raw ?? "")).toEqual({ type: "activity", participantId: b.init.self, activity: "replying" });
    }
    // Not echoed to the socket that sent it.
    b.ws.send("ping");
    expect(await b.inbox.next(1)).toEqual(["pong"]);

    b.ws.close();
    const [aLeft] = await a.inbox.next(1);
    const [cLeft] = await c.inbox.next(1);
    for (const raw of [aLeft, cLeft])
      expect(conforming(raw ?? "")).toEqual({ type: "left", participantId: b.init.self });

    // Who joins next sees the room as it is now: the activity stuck, the dropped socket is gone.
    a.ws.close();
    await c.inbox.next(1);
    const d = await open(await userTicket("u-d", "open-6"));
    expect(d.init.participants.map((p) => p.ref)).toEqual(["u-c", "u-d"]);
  });

  test("refuses an undeclared activity, a frame past the size limit, and anything but its frames", async () => {
    const a = await open(await userTicket("u-a", "open-7"));
    const b = await open(await userTicket("u-b", "open-7"));
    await a.inbox.next(1);
    const before = b.inbox.frames.length;
    for (const frame of [
      JSON.stringify({ type: "set_activity", activity: "typing" }),
      JSON.stringify({ type: "set_activity", activity: "viewing", pad: "x".repeat(PRESENCE_MAX_FRAME_BYTES) }),
      "hello",
      JSON.stringify({ type: "kick", participantId: b.init.self }),
    ]) {
      a.ws.send(frame);
      const [raw] = await a.inbox.next(1);
      expect(conforming(raw ?? "")).toMatchObject({ type: "error", error: { code: "validation/invalid_input" } });
    }
    a.ws.send("ping");
    expect(await a.inbox.next(1)).toEqual(["pong"]);
    // Nothing a refused frame said reached anyone else.
    expect(b.inbox.frames.length).toBe(before);
  });

  test("refuses past the room kind's participant cap", async () => {
    for (const user of ["u-1", "u-2", "u-3"]) await open(await userTicket(user, "open-8"));
    const response = await upgrade(
      "/support/presence/rooms/support.thread/open-8",
      `pithy.presence.v1, ${PRESENCE_TICKET_PROTOCOL_PREFIX}${(await userTicket("u-4", "open-8")).ticket}`,
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("core/presence_room_full");
  });

  test("keeps each participant in its socket's attachment, and writes nothing to storage, D1 or KV", async () => {
    const rowsBefore = await rowCounts();
    const a = await open(await userTicket("u-a", "open-9"));
    await open(await userTicket("u-b", "open-9"));
    await a.inbox.next(1);
    a.ws.send(JSON.stringify({ type: "set_activity", activity: "replying" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const ns = BINDINGS[PRESENCE_ROOMS_BINDING];
    const stub = ns.get(ns.idFromName("support.thread:open-9"));
    await runInDurableObject(stub, async (_room, state) => {
      const attachments = state.getWebSockets().map((ws) => PresenceAttachment.parse(ws.deserializeAttachment()));
      const seen = attachments.map((attachment) => [attachment.participant.ref, attachment.participant.activity]);
      expect(seen.sort()).toEqual([
        ["u-a", "replying"],
        ["u-b", "viewing"],
      ]);
      expect((await state.storage.list()).size).toBe(0);
    });
    // Every table's row count, not only the list of tables: a write into a table that already exists leaves
    // the list exactly as it was.
    expect(await rowCounts()).toEqual(rowsBefore);
    for (const kv of [env.SESSIONS, env.CONTROL_PLANE]) expect((await kv.list()).keys).toEqual([]);
  });
});

describe("the manifest", () => {
  test("lists each room kind under the capability that declares it, with the paths it mounted", async () => {
    await connect([MANIFEST_READ_SCOPE]);
    const token = await mintControlPlaneToken({
      privateKey: key.privateKey,
      keyId: key.keyId,
      issuer: ISSUER,
      connectionId: CONNECTION_ID,
      subject: "usr_operator",
      scope: MANIFEST_READ_SCOPE,
    });
    const response = await backend.request(
      "http://worker.example/control-plane/manifest",
      { headers: { [CONTROL_PLANE_HEADER]: token } },
      BINDINGS,
    );
    expect(response.status).toBe(200);
    const manifest = ControlPlaneManifest.parse(await response.json());
    const entry = manifest.capabilities.find((capability) => capability.name === "support");
    expect(entry?.presenceRooms).toEqual([
      {
        kind: "support.thread",
        scope: THREADS_READ,
        activities: ["viewing", "replying"],
        maxParticipants: 3,
        sessionTicketPath: "/support/presence/tickets",
        socketPath: "/support/presence/rooms/:kind/:recordId",
      },
      {
        kind: "support.inbox",
        scope: INBOX_READ,
        activities: ["viewing"],
        maxParticipants: 25,
        sessionTicketPath: null,
        socketPath: "/support/presence/rooms/:kind/:recordId",
      },
    ]);
    expect(manifest.capabilities.find((capability) => capability.name === "signedin")?.presenceRooms).toEqual([]);
  });
});
