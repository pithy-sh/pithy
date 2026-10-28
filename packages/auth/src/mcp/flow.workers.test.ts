// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import { appTools } from "@pithy-sh/core/src/mcp/tools";
import { routeGroupsOf } from "@pithy-sh/core/src/openapi/routeGroups";
import { email } from "@pithy-sh/email/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { auth } from "../capability";
import { requireAuth } from "../http/middleware";
import {
  prepareScopedBackend,
  SCOPED_ORIGIN,
  SCOPED_REGISTRY,
  scopedWorkerEnv,
  signInScoped,
} from "../test-utils/scopedBackend";
import { MCP_MIGRATION_ORDER, type McpConfigInput, mcp, PROVIDER_MIGRATION } from "./capability";
import { dispatchRequest } from "./dispatch";
import { eraseMcpUser, exportMcpUser } from "./purge";

/**
 * **The using path, end to end, through a real `auth()` and a real authorization server.**
 *
 * An MCP client starts from the endpoint's URL alone: it is refused with a challenge naming the protected-resource
 * metadata, finds the authorization server there, registers itself, runs an authorization code exchange with PKCE
 * as a signed-in user who approves the consent screen, and comes back with a resource-bound token. Every step here
 * is the real one; only the browser is played by `app.request`.
 */

/** Which powers each user's role holds — the acting-organization seam, filled the way organization fills it. */
const roles = new Map<string, string[]>();
/** Every request the notes routes saw, as who. */
const seen: { route: string; userId: string | null }[] = [];
const emitted: AuditEventInput[] = [];
/** The consent decisions in {@link emitted}, as the trail records them. */
const grants = () => emitted.filter((event) => event.action.startsWith("auth/mcp_grant_"));

const Note = z.object({ id: z.string().describe("The note's id.") }).describe("A note.");
const NoteParam = z.object({ id: z.string().describe("Which note.") }).describe("Which note.");
const NoteBody = z.object({ text: z.string().describe("What it says.") }).describe("A note to write.");

/** An app with one read, one write behind a power, and one route that is not a tool. */
const notes = defineCapability({
  name: "notes",
  requiredBindings: [],
  middleware: [
    (app) => {
      app.use("*", async (c, next) => {
        c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
        c.set("actingOrganization", async () => {
          const userId = c.var.auth?.userId;
          if (userId === undefined) return null;
          const held = roles.get(userId) ?? [];
          return { organizationId: "org-1", roleAllows: (power: string) => held.includes(power) };
        });
        await next();
      });
    },
  ],
  routes: (app) => {
    app.get(
      "/notes/:id",
      describeRoute({
        summary: "Read a note.",
        verification: ["bearer", "session"],
        responses: { 200: Note },
        operation: "notes.read",
        tool: true,
      }),
      requireAuth(),
      validate("param", NoteParam),
      (c) => {
        seen.push({ route: "read", userId: c.var.auth?.userId ?? null });
        return c.json({ id: c.req.valid("param").id });
      },
    );
    app.post(
      "/notes",
      describeRoute({
        summary: "Write a note.",
        verification: ["bearer", "session"],
        responses: { 200: Note },
        operation: "notes.write",
        tool: { effect: "writes" },
        power: "notes:write",
      }),
      requireAuth(),
      validate("json", NoteBody),
      (c) => {
        seen.push({ route: "write", userId: c.var.auth?.userId ?? null });
        return c.json({ id: c.req.valid("json").text });
      },
    );
    app.get(
      "/notes",
      describeRoute({ summary: "List notes.", verification: ["bearer", "session"], responses: { 200: Note } }),
      requireAuth(),
      (c) => c.json({ id: "all" }),
    );
  },
});

function buildApp(floor: McpConfigInput["floor"] = "signed-in", baseURL = SCOPED_ORIGIN) {
  return createBackend({
    capabilities: [
      secrets({ registry: SCOPED_REGISTRY }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: SCOPED_ORIGIN }),
      auth({ baseURL, basePath: "/auth", trustedOrigins: [SCOPED_ORIGIN] }),
      mcp({ floor }),
    ],
    app: notes,
  });
}

type App = ReturnType<typeof buildApp>;
const workerEnv = () => scopedWorkerEnv(env as unknown as Record<string, unknown>);
const RESOURCE = `${SCOPED_ORIGIN}/mcp`;
const REDIRECT = "http://127.0.0.1:7777/callback";

async function call(app: App, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, init, workerEnv());
}

/** base64url of the SHA-256 of a verifier: PKCE's S256 challenge. */
async function challengeOf(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Register a client the way an MCP client does: open, dynamic, public, PKCE. */
async function register(app: App, name = "POWERPLAY Official Sync"): Promise<string> {
  const metadata = (await (await call(app, "/.well-known/oauth-authorization-server/auth")).json()) as Record<
    string,
    string
  >;
  const res = await call(app, new URL(metadata.registration_endpoint ?? "").pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Start an authorization as a signed-in user, and land on the consent screen's query. */
async function authorize(app: App, clientId: string, session: string, verifier: string): Promise<string> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "mcp offline_access",
    state: "s1",
    code_challenge: await challengeOf(verifier),
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const res = await call(app, `/auth/oauth2/authorize?${query}`, {
    headers: { authorization: `Bearer ${session}` },
    redirect: "manual",
  });
  const location = res.headers.get("location") ?? "";
  expect(location, `${res.status} ${await res.clone().text()}`).toContain("/agent-consent?");
  return location.slice(location.indexOf("?") + 1);
}

/** Send the consent screen's one decision. */
async function decideOn(app: App, session: string, oauthQuery: string, accept: boolean): Promise<Response> {
  return call(app, "/mcp/consent", {
    method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json", origin: SCOPED_ORIGIN },
    body: JSON.stringify({ oauth_query: oauthQuery, accept }),
  });
}

/** Approve on the consent screen, and exchange the code for a token. */
async function approveAndExchange(
  app: App,
  clientId: string,
  session: string,
  oauthQuery: string,
  verifier: string,
): Promise<{ access_token: string; refresh_token?: string }> {
  const decided = await decideOn(app, session, oauthQuery, true);
  expect(decided.status, await decided.clone().text()).toBe(200);
  const body = (await decided.json()) as { redirect: string };
  const redirect = new URL(body.redirect);
  const code = redirect.searchParams.get("code") ?? "";
  expect(code).not.toBe("");
  const token = await call(app, "/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }).toString(),
  });
  expect(token.status, await token.clone().text()).toBe(200);
  return (await token.json()) as { access_token: string; refresh_token?: string };
}

async function rpc(app: App, token: string, method: string, params?: Record<string, unknown>) {
  const res = await call(app, "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      jsonrpc?: string;
      id?: string | number;
      result?: Record<string, unknown>;
      error?: unknown;
    },
  };
}

/** A user, signed in, through the whole flow, holding a token. */
async function connected(app: App, address = "agent@test.com") {
  const { token: session, userId } = await signInScoped(env.DB, address);
  const clientId = await register(app);
  const verifier = `verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const oauthQuery = await authorize(app, clientId, session, verifier);
  const tokens = await approveAndExchange(app, clientId, session, oauthQuery, verifier);
  return { session, userId, clientId, oauthQuery, verifier, tokens };
}

beforeEach(async () => {
  roles.clear();
  seen.length = 0;
  emitted.length = 0;
  await prepareScopedBackend(env, [
    { namespace: "mcp", order: MCP_MIGRATION_ORDER, migrations: { "0001_init": PROVIDER_MIGRATION } },
  ]);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("discovery, from the URL alone", () => {
  test("an unauthenticated request is challenged with where to find the authorization server", async () => {
    const res = await call(buildApp(), "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${SCOPED_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
    );
  });

  test("an unauthenticated request with a malformed body is challenged too, not told what was malformed", async () => {
    for (const body of ["not json", JSON.stringify({ jsonrpc: "1.0" }), JSON.stringify([{ jsonrpc: "2.0" }])]) {
      const res = await call(buildApp(), "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status, body).toBe(401);
      expect(res.headers.get("www-authenticate"), body).toContain("resource_metadata=");
    }
  });

  test("a GET or DELETE on the endpoint is 405, naming POST, since it offers no stream and keeps no session", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await call(buildApp(), "/mcp", { method, headers: { accept: "text/event-stream" } });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("POST");
    }
  });

  test("the protected-resource metadata names this endpoint and its issuer", async () => {
    const res = await call(buildApp(), "/.well-known/oauth-protected-resource/mcp");
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [`${SCOPED_ORIGIN}/auth`],
      scopes_supported: ["mcp", "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "This application's MCP endpoint",
    });
  });

  test("the authorization server's metadata is where its issuer says, and offers only the one scope", async () => {
    const metadata = (await (await call(buildApp(), "/.well-known/oauth-authorization-server/auth")).json()) as {
      issuer: string;
      registration_endpoint: string;
      scopes_supported: string[];
      grant_types_supported: string[];
      code_challenge_methods_supported: string[];
    };
    expect(metadata.issuer).toBe(`${SCOPED_ORIGIN}/auth`);
    expect(metadata.registration_endpoint).toBe(`${SCOPED_ORIGIN}/auth/oauth2/register`);
    expect(metadata.scopes_supported).toEqual(["mcp", "offline_access"]);
    expect(metadata.grant_types_supported).not.toContain("client_credentials");
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
  });
});

describe("a dev Worker, served on a host its config does not name", () => {
  /** The deployed origin the config names. Every request below arrives on {@link SCOPED_ORIGIN} instead. */
  const DEPLOYED = "https://app.example.com";

  beforeEach(() => {
    process.env.ENVIRONMENT = "dev";
  });

  afterEach(() => {
    delete process.env.ENVIRONMENT;
  });

  test("the metadata and the challenge name the origin the request arrived on", async () => {
    const app = buildApp("signed-in", DEPLOYED);
    const metadata = (await (await call(app, "/.well-known/oauth-protected-resource/mcp")).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(metadata.resource).toBe(RESOURCE);
    expect(metadata.authorization_servers).toEqual([`${SCOPED_ORIGIN}/auth`]);
    const refused = await call(app, "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(refused.headers.get("www-authenticate")).toContain(
      `resource_metadata="${SCOPED_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test("the token is minted for the request's origin, and that origin's endpoint accepts it", async () => {
    const app = buildApp("signed-in", DEPLOYED);
    const { tokens } = await connected(app);
    const payload = JSON.parse(atob((tokens.access_token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload.aud === RESOURCE || (Array.isArray(payload.aud) && payload.aud.includes(RESOURCE))).toBe(true);
    expect(payload.iss).toBe(`${SCOPED_ORIGIN}/auth`);
    expect((await rpc(app, tokens.access_token, "tools/list")).status).toBe(200);
  });
});

describe("an MCP client reaches an authorized session", () => {
  test("register, authorize with PKCE, approve, exchange, and call", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);

    const init = await rpc(app, tokens.access_token, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });

    const read = await rpc(app, tokens.access_token, "tools/call", {
      name: "notes_notes_read",
      arguments: { path: { id: "n1" } },
    });
    expect(read.body.result).toMatchObject({ isError: false, structuredContent: { id: "n1" } });
    expect(seen).toEqual([{ route: "read", userId }]);
  });

  test("the token is resource-bound: its audience is this endpoint and nothing else", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    const [, payload] = tokens.access_token.split(".");
    const claims = JSON.parse(atob((payload ?? "").replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    expect(claims.aud).toBe(RESOURCE);
    expect(claims.sub).toBe(userId);
    expect(claims.sid).toEqual(expect.any(String));
    // The scope is one constant value: there is no permission selection in it.
    expect(String(claims.scope).split(" ").sort()).toEqual(["mcp", "offline_access"]);
    // And it is not a session: the app's own routes do not take it.
    const direct = await call(app, "/notes/n1", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(direct.status).toBe(401);
  });

  test("a token minted for another resource is refused at this endpoint", async () => {
    const app = buildApp();
    const { tokens } = await connected(app);
    const other = createBackend({
      capabilities: [
        secrets({ registry: SCOPED_REGISTRY }),
        email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: SCOPED_ORIGIN }),
        auth({ baseURL: SCOPED_ORIGIN, basePath: "/auth", trustedOrigins: [SCOPED_ORIGIN] }),
        mcp({ floor: "signed-in", path: "/agents" }),
      ],
      app: notes,
    });
    const res = await other.request(
      "/agents",
      {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      workerEnv(),
    );
    expect(res.status).toBe(401);
  });
});

describe("the role is the only authority", () => {
  test("tools/list differs by the caller's role, and a withheld tool is absent", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    const names = async () =>
      (((await rpc(app, tokens.access_token, "tools/list")).body.result?.tools ?? []) as { name: string }[]).map(
        (tool) => tool.name,
      );
    expect(await names()).toEqual(["notes_notes_read"]);
    roles.set(userId, ["notes:write"]);
    expect(await names()).toEqual(["notes_notes_read", "notes_notes_write"]);
  });

  test("no tool call consults the token: the same token gains and loses a tool with the role alone", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    const write = () =>
      rpc(app, tokens.access_token, "tools/call", { name: "notes_notes_write", arguments: { body: { text: "x" } } });

    // Withheld: answered as a tool that does not exist, and the route never runs.
    expect((await write()).body.error).toMatchObject({ code: -32602 });
    expect(seen).toEqual([]);

    // Granted by the role, with no new token and no new consent: the call goes through.
    roles.set(userId, ["notes:write"]);
    expect((await write()).body.result).toMatchObject({ isError: false });
    expect(seen).toEqual([{ route: "write", userId }]);

    // Taken away again: gone again, with the same token.
    roles.set(userId, []);
    expect((await write()).body.error).toMatchObject({ code: -32602 });
  });

  test("a dispatched call meets the route's own gates — the endpoint adds none of its own", async () => {
    // The request a tool call makes, sent straight to the app as a user whose role lacks the route's power: the
    // route's describeRoute gate refuses it. Nothing about the token or the consent is anywhere in the request.
    const app = buildApp();
    const { userId } = await connected(app);
    const asUser = { userId, sessionId: "s", scopes: [] };
    const tools = appTools(routeGroupsOf(app) ?? []);
    const write = tools.find((tool) => tool.name === "notes_notes_write");
    if (write === undefined) throw new Error("expected the write tool");
    const refused = await app.fetch(
      dispatchRequest(SCOPED_ORIGIN, write, { body: { text: "x" } }, asUser),
      workerEnv(),
    );
    expect(refused.status).toBe(403);
    expect(seen).toEqual([]);
    roles.set(userId, ["notes:write"]);
    const allowed = await app.fetch(
      dispatchRequest(SCOPED_ORIGIN, write, { body: { text: "x" } }, asUser),
      workerEnv(),
    );
    expect(allowed.status).toBe(200);
    expect(seen).toEqual([{ route: "write", userId }]);
  });

  test("a path argument cannot climb out of the tool's route into one that never opted in", async () => {
    const app = buildApp();
    const { tokens } = await connected(app);
    for (const id of ["..", "."]) {
      const read = await rpc(app, tokens.access_token, "tools/call", {
        name: "notes_notes_read",
        arguments: { path: { id } },
      });
      expect(read.status, id).toBe(200);
      expect(read.body.jsonrpc, id).toBe("2.0");
      expect(read.body.id, id).toBe(1);
      expect(read.body.result?.isError, id).toBe(true);
      expect(JSON.stringify(read.body.result?.content), id).toContain("cannot be called with that path");
    }
    expect(seen).toEqual([]);
  });

  test("a call missing a path argument is answered as a tool error the agent can correct", async () => {
    const app = buildApp();
    const { tokens } = await connected(app);
    const read = await rpc(app, tokens.access_token, "tools/call", { name: "notes_notes_read", arguments: {} });
    expect(read.status).toBe(200);
    expect(read.body.jsonrpc).toBe("2.0");
    expect(read.body.id).toBe(1);
    expect(read.body.error).toBeUndefined();
    expect(read.body.result?.isError).toBe(true);
    expect(JSON.stringify(read.body.result?.content)).toContain("needs path.id");
    expect(seen).toEqual([]);
  });

  test("a route that never opted in is not a tool", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    roles.set(userId, ["notes:write"]);
    const tools = ((await rpc(app, tokens.access_token, "tools/list")).body.result?.tools ?? []) as { name: string }[];
    expect(tools.map((tool) => tool.name)).not.toContain("notes_notes_list");
  });
});

describe("the floor", () => {
  test("a power floor refuses a caller whose role lacks it, and admits one who holds it", async () => {
    const app = buildApp({ power: "agents:use" });
    const { tokens, userId } = await connected(app);
    expect((await rpc(app, tokens.access_token, "tools/list")).status).toBe(403);
    roles.set(userId, ["agents:use"]);
    expect((await rpc(app, tokens.access_token, "tools/list")).status).toBe(200);
  });

  test("an entitlement floor refuses a caller holding nothing, since no provider is composed", async () => {
    const app = buildApp({ entitlement: "pro" });
    const { tokens } = await connected(app);
    expect((await rpc(app, tokens.access_token, "tools/list")).status).toBe(403);
  });
});

describe("consent", () => {
  test("the screen shows the reported name as reported, the redirect URI, and only what the role reaches", async () => {
    const app = buildApp();
    const { token: session, userId } = await signInScoped(env.DB, "viewer@test.com");
    roles.set(userId, []);
    const clientId = await register(app);
    const oauthQuery = await authorize(app, clientId, session, `v-${crypto.randomUUID()}-${crypto.randomUUID()}`);
    const res = await call(app, `/mcp/consent?oauth_query=${encodeURIComponent(oauthQuery)}`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as {
      client: Record<string, unknown>;
      capabilities: { capability: string; reachable: number; total: number; operations: { tool: string }[] }[];
      requested: { scope: string; granted: boolean }[];
    };
    expect(view.client).toEqual({
      id: clientId,
      reportedName: "POWERPLAY Official Sync",
      reportedUri: null,
      redirectUri: REDIRECT,
    });
    expect(view.capabilities).toEqual([
      expect.objectContaining({
        capability: "notes",
        reachable: 1,
        total: 2,
        operations: [expect.objectContaining({ tool: "notes_notes_read" })],
      }),
    ]);
    expect(view.requested).toEqual([
      { scope: "mcp", granted: true, reason: null },
      { scope: "offline_access", granted: true, reason: null },
    ]);
  });

  test("a tampered authorization query is refused", async () => {
    const app = buildApp();
    const { token: session } = await signInScoped(env.DB);
    const clientId = await register(app);
    const oauthQuery = await authorize(app, clientId, session, `v-${crypto.randomUUID()}-${crypto.randomUUID()}`);
    const tampered = oauthQuery.replace(encodeURIComponent(REDIRECT), encodeURIComponent("https://evil.test/cb"));
    const res = await call(app, `/mcp/consent?oauth_query=${encodeURIComponent(tampered)}`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.status).toBe(400);
  });

  test("a client asking again gets the screen again, and each approval is its own audit row", async () => {
    const app = buildApp();
    const { session, clientId, userId } = await connected(app);
    // Already approved once: the provider would skip; this kit asks again.
    const verifier = `v-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const again = await authorize(app, clientId, session, verifier);
    await approveAndExchange(app, clientId, session, again, verifier);
    const approved = {
      action: "auth/mcp_grant_approved",
      actorType: "user",
      actorId: userId,
      outcome: "success",
      resourceType: "mcp_client",
      resourceId: clientId,
      metadata: { redirectUri: REDIRECT, scope: "mcp offline_access" },
    };
    expect(grants()).toEqual([expect.objectContaining(approved), expect.objectContaining(approved)]);
  });

  test("refusing sends the browser back with the provider's refusal, no code, and an audit row", async () => {
    const app = buildApp();
    const { token: session, userId } = await signInScoped(env.DB, "refuser@test.com");
    const clientId = await register(app);
    const oauthQuery = await authorize(app, clientId, session, `v-${crypto.randomUUID()}-${crypto.randomUUID()}`);
    const decided = await decideOn(app, session, oauthQuery, false);
    expect(decided.status, await decided.clone().text()).toBe(200);
    const redirect = new URL(((await decided.json()) as { redirect: string }).redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.has("code")).toBe(false);
    expect(grants()).toEqual([
      expect.objectContaining({
        action: "auth/mcp_grant_denied",
        actorId: userId,
        resourceType: "mcp_client",
        resourceId: clientId,
        metadata: { redirectUri: REDIRECT, scope: "mcp offline_access" },
      }),
    ]);
    // And nothing was granted: no connected application, no consent.
    const listed = await call(app, "/mcp/connections", { headers: { authorization: `Bearer ${session}` } });
    expect(((await listed.json()) as { applications: unknown[] }).applications).toEqual([]);
  });

  test("a client asking to be shown nothing gets no code, even with a consent on record", async () => {
    const app = buildApp();
    const { session, clientId } = await connected(app);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "mcp offline_access",
      state: "s1",
      code_challenge: await challengeOf(`v-${crypto.randomUUID()}-${crypto.randomUUID()}`),
      code_challenge_method: "S256",
      resource: RESOURCE,
      prompt: "none",
    });
    const res = await call(app, `/auth/oauth2/authorize?${query}`, {
      headers: { authorization: `Bearer ${session}` },
      redirect: "manual",
    });
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("code=");
    expect(location).not.toContain("/agent-consent?");
    const body = await res.text();
    expect(body).not.toContain("code=");
    expect(`${location} ${body}`).toContain("consent_required");
  });
});

describe("connected applications", () => {
  test("a user sees what they approved and revokes it, and the token stops working at once", async () => {
    const app = buildApp();
    const { session, clientId, tokens } = await connected(app);
    const listed = await call(app, "/mcp/connections", { headers: { authorization: `Bearer ${session}` } });
    expect(
      ((await listed.json()) as { applications: { clientId: string; reportedName: string }[] }).applications,
    ).toEqual([
      expect.objectContaining({ clientId, reportedName: "POWERPLAY Official Sync", redirectUris: [REDIRECT] }),
    ]);

    const revoked = await call(app, `/mcp/connections/${clientId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session}`, origin: SCOPED_ORIGIN },
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(grants().at(-1)).toEqual(
      expect.objectContaining({
        action: "auth/mcp_grant_revoked",
        actorType: "user",
        outcome: "success",
        resourceType: "mcp_client",
        resourceId: clientId,
      }),
    );
    expect(grants().map((event) => event.action)).toEqual(["auth/mcp_grant_approved", "auth/mcp_grant_revoked"]);
    expect((await rpc(app, tokens.access_token, "tools/list")).status).toBe(401);
    const after = await call(app, "/mcp/connections", { headers: { authorization: `Bearer ${session}` } });
    expect(((await after.json()) as { applications: unknown[] }).applications).toEqual([]);
  });

  test("a token whose session has ended is refused", async () => {
    const app = buildApp();
    const { session, tokens } = await connected(app);
    await call(app, "/auth/sign-out", {
      method: "POST",
      headers: { authorization: `Bearer ${session}`, origin: SCOPED_ORIGIN },
    });
    expect((await rpc(app, tokens.access_token, "tools/list")).status).toBe(401);
  });
});

describe("erasure and export", () => {
  const TABLES = ["pithy_mcp_consents", "pithy_mcp_access_tokens", "pithy_mcp_refresh_tokens"] as const;
  const ENV = () => env as unknown as Record<string, unknown>;

  async function held(userId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      const row = await env.DB.prepare(`select count(*) as n from ${table} where user_id = ?`).bind(userId).first<{
        n: number;
      }>();
      counts[table] = row?.n ?? -1;
    }
    return counts;
  }

  const clients = async () =>
    (await env.DB.prepare("select count(*) as n from pithy_mcp_clients").first<{ n: number }>())?.n ?? -1;

  test("erase takes the subject's consents and tokens, nobody else's, and leaves every client", async () => {
    const app = buildApp();
    const subject = await connected(app, "subject@test.com");
    const other = await connected(app, "other@test.com");
    const before = await held(other.userId);
    expect((await held(subject.userId)).pithy_mcp_consents).toBe(1);
    expect((await held(subject.userId)).pithy_mcp_refresh_tokens).toBeGreaterThan(0);
    expect(await clients()).toBe(2);

    await eraseMcpUser({ subject: { type: "user", id: subject.userId }, env: ENV() }, "DB");

    expect(await held(subject.userId)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));
    expect(await held(other.userId)).toEqual(before);
    expect(await clients()).toBe(2);
    // With the consent gone, the token minted under it stops at the endpoint.
    expect((await rpc(app, subject.tokens.access_token, "tools/list")).status).toBe(401);
    expect((await rpc(app, other.tokens.access_token, "tools/list")).status).toBe(200);

    // And a second run succeeds, having found nothing.
    await eraseMcpUser({ subject: { type: "user", id: subject.userId }, env: ENV() }, "DB");
    expect(await held(subject.userId)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));
  });

  test("export holds the subject's rows from each table, and no credential", async () => {
    const app = buildApp();
    const subject = await connected(app, "subject@test.com");
    await connected(app, "other@test.com");
    const exported = await exportMcpUser({ subject: { type: "user", id: subject.userId }, env: ENV() }, "DB");
    expect(Object.keys(exported).sort()).toEqual(["pithyMcpAccessTokens", "pithyMcpConsents", "pithyMcpRefreshTokens"]);
    const consents = exported.pithyMcpConsents as Record<string, unknown>[];
    expect(consents).toEqual([expect.objectContaining({ clientId: subject.clientId, userId: subject.userId })]);
    const refresh = exported.pithyMcpRefreshTokens as Record<string, unknown>[];
    expect(refresh.length).toBeGreaterThan(0);
    for (const rows of Object.values(exported) as Record<string, unknown>[][]) {
      for (const row of rows) {
        expect(row.userId).toBe(subject.userId);
        for (const column of Object.keys(row)) expect(column).not.toMatch(/secret|token|key|code|hash|password/i);
      }
    }
    // Nor does any value carry the credential itself.
    const text = JSON.stringify(exported);
    expect(text).not.toContain(subject.tokens.access_token);
    if (subject.tokens.refresh_token !== undefined) expect(text).not.toContain(subject.tokens.refresh_token);
  });
});
