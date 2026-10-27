// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { AuditEventInput } from "../../audit/auditEvent";
import type { PithyHonoEnv } from "../../capability/capability";
import { pithyErrorHandler } from "../../error/http";
import { validate } from "../../http/validation";
import type { PresenceDeclaration } from "../../presence/declaration";
import { ControlPlanePresenceTicketRequest } from "../../presence/http/schemas";
import { verifyPresenceTicket } from "../../presence/ticket";
import { ControlPlaneAuditActions } from "../audit/actions";
import { ControlPlaneConfig } from "../config/config";
import type { ControlPlaneConnection, Ed25519PublicJwk } from "../data/connection";
import { ANY_VERIFIED_CALLER, MANIFEST_READ_SCOPE } from "../scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "../token/mint";
import { CONTROL_PLANE_HEADER } from "../wire";
import { createControlPlaneVerifier, isControlPlaneGuard } from "./guard";
import type { ControlPlaneHandlerDeps } from "./handlers";
import { presenceTicketGate, presenceTicketHandler, presenceTicketRequirement } from "./presence";

/**
 * **`POST /control-plane/presence/tickets`, its gate and its handler, directly** (#815) — mounted the way
 * `registerControlPlaneRoutes` mounts them, against a real verifier and a recorded audit trail.
 *
 * The scope the call needs is the room kind's, named in the body, so the gate reads the kind before it
 * verifies. That is what keeps a refused mint to the one denial row every other control-plane route writes,
 * rather than an allowed row followed by a denial.
 */

const ENVIRONMENT = "production";
const ISSUER = "https://app.pithy.sh";
const CONNECTION_ID = "0d1f4b6e-7c2a-4f52-9c1f-2b6a5d3e8a91";
const KEY_ID = "key_presence";
const SUBJECT = "usr_operator";
const THREADS_READ = "support:threads:read";
const TICKET_KEY = "presence-unit-key";
const PATH = "/control-plane/presence/tickets";

const presence: PresenceDeclaration = {
  basePath: "/support",
  ticketKey: TICKET_KEY,
  rooms: [{ kind: "support.thread", scope: THREADS_READ, activities: ["viewing"] }],
};

const deps = {
  composedPresence: () => new Map([["support.thread", presence]]),
} as unknown as ControlPlaneHandlerDeps;

let keyPair: CryptoKeyPair;
let publicJwk: Ed25519PublicJwk;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicJwk = await exportPublicJwk(keyPair.publicKey);
});

function connection(): ControlPlaneConnection {
  const yesterday = new Date(Date.now() - 86_400_000);
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: ISSUER,
    workerUrl: "https://api.example.com",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "Support triage.",
    scopes: [MANIFEST_READ_SCOPE, THREADS_READ],
    keys: [{ keyId: KEY_ID, publicKey: publicJwk, validFrom: yesterday, validUntil: null, revokedAt: null }],
    createdAt: yesterday,
    updatedAt: yesterday,
  };
}

const recorded: AuditEventInput[] = [];
beforeEach(() => {
  recorded.length = 0;
});

function makeApp(): Hono<PithyHonoEnv> {
  const seen = new Set<string>();
  const verifier = createControlPlaneVerifier({
    loadConnection: async (id) => (id === CONNECTION_ID ? connection() : null),
    countConnections: async () => 1,
    replay: {
      async claim(jti) {
        if (seen.has(jti)) return false;
        seen.add(jti);
        return true;
      },
    },
    environment: ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => new Date(),
  });
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", verifier);
    c.set("emit", async (event: AuditEventInput) => {
      recorded.push(event);
    });
    await next();
  });
  app.post(PATH, presenceTicketGate(deps), validate("json", ControlPlanePresenceTicketRequest), (c) =>
    presenceTicketHandler(deps)(c, c.req.valid("json")),
  );
  return app;
}

async function call(scope: string | null, body: unknown): Promise<Response> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (scope !== null) {
    headers[CONTROL_PLANE_HEADER] = await mintControlPlaneToken({
      privateKey: keyPair.privateKey,
      keyId: KEY_ID,
      issuer: ISSUER,
      connectionId: CONNECTION_ID,
      subject: SUBJECT,
      scope,
      body: new TextEncoder().encode(payload),
    });
  }
  return makeApp().request(PATH, { method: "POST", headers, body: payload }, { ENVIRONMENT });
}

const actions = () => recorded.map((event) => event.action);
const thread = (kind = "support.thread") => ({ kind, recordId: "th-1", participant: { ref: "op-7", name: "Ada" } });

describe("presenceTicketRequirement", () => {
  const requirementOf = (body: string) =>
    presenceTicketRequirement(deps)({
      req: { raw: new Request("https://w.example/", { method: "POST", body }) },
    } as never);

  test("a declared kind needs that kind's scope", async () => {
    expect(await requirementOf(JSON.stringify(thread()))).toBe(THREADS_READ);
  });

  test("an undeclared kind, a body with no kind, and one that is not JSON need only a verified caller", async () => {
    for (const body of [JSON.stringify(thread("support.macro")), "{}", '{"kind":7}', "not json", ""]) {
      expect(await requirementOf(body)).toBe(ANY_VERIFIED_CALLER);
    }
  });

  test("the body is read from a copy, so the route's validator still reads it", async () => {
    const raw = new Request("https://w.example/", { method: "POST", body: JSON.stringify(thread()) });
    await presenceTicketRequirement(deps)({ req: { raw } } as never);
    expect(raw.bodyUsed).toBe(false);
  });
});

describe("POST /control-plane/presence/tickets", () => {
  test("its gate is a control-plane guard, so the route is read back as admin surface", () => {
    expect(isControlPlaneGuard(presenceTicketGate(deps))).toBe(true);
  });

  test("a scope the kind does not cover is refused with one denial naming the kind's scope, and no allowed row", async () => {
    const response = await call(MANIFEST_READ_SCOPE, thread());
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("controlplane/insufficient_scope");
    expect(actions()).toEqual([ControlPlaneAuditActions.callDenied]);
    expect(recorded[0]?.metadata).toMatchObject({ reason: "controlplane/insufficient_scope", required: THREADS_READ });
  });

  test("an undeclared kind is a 404 for a verified caller, with no denial written", async () => {
    const response = await call(MANIFEST_READ_SCOPE, thread("support.macro"));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("core/not_found");
    expect(actions()).not.toContain(ControlPlaneAuditActions.callDenied);
  });

  test("a caller with no credential is refused before any kind is looked at", async () => {
    const response = await call(null, thread("support.macro"));
    expect(response.status).toBe(401);
    expect(actions()).toEqual([ControlPlaneAuditActions.callDenied]);
  });

  test("the kind's scope mints a control-plane ticket for the participant the body names", async () => {
    const response = await call(THREADS_READ, thread());
    expect(response.status).toBe(201);
    expect(actions()).toEqual([ControlPlaneAuditActions.callAllowed]);
    expect(recorded[0]).toMatchObject({ actorId: SUBJECT, metadata: { scope: THREADS_READ } });
    const minted = (await response.json()) as { ticket: string };
    const claims = await verifyPresenceTicket(minted.ticket, { kind: "support.thread", recordId: "th-1" }, [
      TICKET_KEY,
    ]);
    expect(claims).toMatchObject({ origin: "control-plane", ref: "op-7", name: "Ada" });
  });
});
