// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { ForbiddenError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import { appTools } from "@pithy-sh/core/src/mcp/tools";
import { routeGroupsOf } from "@pithy-sh/core/src/openapi/routeGroups";
import { email } from "@pithy-sh/email/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
/** What the app's emitter does: record, throw as a broken audit write would, or stay the no-op of a Worker with none. */
let emitter: "record" | "throw" | "absent" = "record";
/** The tool-call rows in {@link emitted}. */
const toolCalls = () => emitted.filter((event) => event.action === "mcp/tool_call");
/** The consent decisions in {@link emitted}, as the trail records them. */
const grants = () => emitted.filter((event) => event.action.startsWith("auth/mcp_grant_"));

const Note = z.object({ id: z.string().describe("The note's id.") }).describe("A note.");
const NoteParam = z.object({ id: z.string().describe("Which note.") }).describe("Which note.");
const NoteBody = z.object({ text: z.string().describe("What it says.") }).describe("A note to write.");

/** An app with one read, one write behind a power, one read behind a power whose answer breaks, and one route that is not a tool. */
const notes = defineCapability({
  name: "notes",
  requiredBindings: [],
  middleware: [
    (app) => {
      app.use("*", async (c, next) => {
        if (emitter === "record") c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
        if (emitter === "throw") {
          c.set("emit", async () => {
            throw new Error("the audit database is down");
          });
        }
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
      async (c) => {
        const { text } = c.req.valid("json");
        if (text === "refuse") throw new ForbiddenError({ message: "Not your note.", detail: "test refusal" });
        seen.push({ route: "write", userId: c.var.auth?.userId ?? null });
        await c.var.emit({
          action: "notes/written",
          outcome: "success",
          actorType: "user",
          actorId: c.var.auth?.userId ?? null,
          requestId: c.req.header("cf-ray"),
        });
        return c.json({ id: text });
      },
    );
    app.get(
      "/notes/:id/broken",
      describeRoute({
        summary: "Read a note whose body breaks mid-answer.",
        verification: ["bearer", "session"],
        responses: { 200: Note },
        operation: "notes.broken",
        tool: true,
        power: "notes:break",
      }),
      requireAuth(),
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("the answer broke mid-stream"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
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

async function rpc(
  app: App,
  token: string,
  method: string,
  params?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const res = await call(app, "/mcp", {
    method: "POST",
    headers: {
      ...headers,
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
  emitter = "record";
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

describe("the audit trail", () => {
  const MARK = "MARKED-VALUE-91c2";

  test("an allowed call writes one row: the user, as an agent, through the client as it reported itself", async () => {
    const app = buildApp();
    const { tokens, userId, clientId } = await connected(app);
    emitted.length = 0;
    const read = await rpc(
      app,
      tokens.access_token,
      "tools/call",
      { name: "notes_notes_read", arguments: { path: { id: "n1" } } },
      { "cf-connecting-ip": "203.0.113.9", "user-agent": "agent/1.0" },
    );
    expect(read.body.result).toMatchObject({ isError: false });
    expect(toolCalls()).toHaveLength(1);
    const [row] = toolCalls();
    expect(row).toMatchObject({
      action: "mcp/tool_call",
      outcome: "success",
      actorType: "user",
      actorId: userId,
      actorKind: "agent",
      tenant: "org-1",
      ip: "203.0.113.9",
      userAgent: "agent/1.0",
      requestId: expect.any(String),
    });
    expect(row?.metadata).toMatchObject({
      tool: "notes_notes_read",
      clientId,
      clientReportedName: "POWERPLAY Official Sync",
      status: 200,
      durationMs: expect.any(Number),
      responseBytes: JSON.stringify({ id: "n1" }).length,
      arguments: { path: { id: "n1" } },
    });
  });

  test("a withheld tool and a made-up one each write a denied row, told apart from an allowed call", async () => {
    const app = buildApp();
    const { tokens } = await connected(app);
    emitted.length = 0;
    await rpc(app, tokens.access_token, "tools/call", {
      name: "notes_notes_write",
      arguments: { body: { text: "x" } },
    });
    await rpc(app, tokens.access_token, "tools/call", { name: "notes_notes_burn" });
    expect(toolCalls().map((row) => [row.outcome, row.metadata?.tool, row.metadata?.refused])).toEqual([
      ["denied", "notes_notes_write", "withheld"],
      ["denied", "notes_notes_burn", "unknown"],
    ]);
    expect(seen).toEqual([]);
  });

  test("a call the endpoint refuses before verifying a caller writes no row: there is no user to name", async () => {
    const app = buildApp();
    const { session, clientId, tokens } = await connected(app);
    await call(app, `/mcp/connections/${clientId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session}`, origin: SCOPED_ORIGIN },
    });
    emitted.length = 0;
    const params = { name: "notes_notes_read", arguments: { path: { id: "n1" } } };
    expect((await rpc(app, tokens.access_token, "tools/call", params)).status).toBe(401);
    expect((await rpc(app, "not-a-token", "tools/call", params)).status).toBe(401);
    expect(toolCalls()).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("a route's refusal is denied and a route's error is failure, each with the route's status", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    roles.set(userId, ["notes:write"]);
    emitted.length = 0;
    const write = (body: unknown) =>
      rpc(app, tokens.access_token, "tools/call", { name: "notes_notes_write", arguments: { body } });
    expect((await write({ text: "refuse" })).body.result).toMatchObject({ isError: true });
    expect((await write({ wrong: 1 })).body.result).toMatchObject({ isError: true });
    expect(toolCalls().map((row) => [row.outcome, row.metadata?.status])).toEqual([
      ["denied", 403],
      ["failure", 400],
    ]);
  });

  test("no argument value reaches a row: the query and body leave their keys and types, the path its ids", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    roles.set(userId, ["notes:write"]);
    emitted.length = 0;
    await rpc(app, tokens.access_token, "tools/call", {
      name: "notes_notes_read",
      arguments: { path: { id: "n1", extra: MARK }, query: { q: MARK, page: 2 } },
    });
    await rpc(app, tokens.access_token, "tools/call", {
      name: "notes_notes_write",
      arguments: { body: { text: MARK, nested: { inner: MARK }, list: [MARK] } },
    });
    expect(JSON.stringify(toolCalls())).not.toContain(MARK);
    expect(toolCalls().map((row) => row.metadata?.arguments)).toEqual([
      {
        path: { id: "n1" },
        query: {
          type: "object",
          keys: [
            { key: "page", type: "number" },
            { key: "q", type: "string" },
          ],
        },
      },
      {
        body: {
          type: "object",
          keys: [
            { key: "list", type: "array" },
            { key: "nested", type: "object" },
            { key: "text", type: "string" },
          ],
        },
      },
    ]);
  });

  test("arguments that build no request write a failure row with the refusal's status and size", async () => {
    const app = buildApp();
    const { tokens } = await connected(app);
    emitted.length = 0;
    const read = await rpc(app, tokens.access_token, "tools/call", { name: "notes_notes_read", arguments: {} });
    const [content] = (read.body.result?.content ?? []) as { text: string }[];
    expect(seen).toEqual([]);
    expect(toolCalls()).toHaveLength(1);
    expect(toolCalls()[0]).toMatchObject({ outcome: "failure", resourceId: "notes_notes_read" });
    expect(toolCalls()[0]?.metadata).toMatchObject({
      status: 400,
      responseBytes: new TextEncoder().encode(content?.text ?? "").byteLength,
      arguments: {},
    });
  });

  test("a call that throws on its way back still writes a row, as a 500 with nothing answered", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    roles.set(userId, ["notes:break"]);
    emitted.length = 0;
    await rpc(app, tokens.access_token, "tools/call", {
      name: "notes_notes_broken",
      arguments: { path: { id: "n1" } },
    });
    expect(toolCalls()).toHaveLength(1);
    expect(toolCalls()[0]).toMatchObject({ outcome: "failure", resourceId: "notes_notes_broken" });
    expect(toolCalls()[0]?.metadata).toMatchObject({
      status: 500,
      responseBytes: 0,
      arguments: { path: { id: "n1" } },
    });
  });

  test("a body padded with huge key names still writes a bounded row for the write it made", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    roles.set(userId, ["notes:write"]);
    emitted.length = 0;
    const junk = Object.fromEntries(Array.from({ length: 63 }, (_, i) => [`${i}`.padEnd(40_000, "j"), 1]));
    const write = await rpc(app, tokens.access_token, "tools/call", {
      name: "notes_notes_write",
      arguments: { path: { id: "x".repeat(40_000) }, body: { text: "kept", ...junk } },
    });
    expect(write.body.result).toMatchObject({ isError: false, structuredContent: { id: "kept" } });
    expect(seen).toEqual([{ route: "write", userId }]);
    expect(toolCalls()).toHaveLength(1);
    expect(toolCalls()[0]?.outcome).toBe("success");
    expect(JSON.stringify(toolCalls()[0]).length).toBeLessThan(32_000);
  });

  test("the route's own rows carry the tool call's request id, given one by the edge or not", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    roles.set(userId, ["notes:write"]);
    for (const headers of [{ "cf-ray": "ray-from-the-edge" }, {}] as Record<string, string>[]) {
      emitted.length = 0;
      await rpc(
        app,
        tokens.access_token,
        "tools/call",
        { name: "notes_notes_write", arguments: { body: { text: "x" } } },
        headers,
      );
      const written = emitted.find((event) => event.action === "notes/written");
      const [row] = toolCalls();
      expect(row?.requestId).toEqual(expect.any(String));
      expect(written?.requestId).toBe(row?.requestId);
    }
    expect(toolCalls()[0]?.requestId).not.toBe("ray-from-the-edge");
  });

  test("a failing audit write does not fail the tool call", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    emitter = "throw";
    const read = await rpc(app, tokens.access_token, "tools/call", {
      name: "notes_notes_read",
      arguments: { path: { id: "n1" } },
    });
    expect(read.body.result).toMatchObject({ isError: false, structuredContent: { id: "n1" } });
    expect(seen).toEqual([{ route: "read", userId }]);
  });

  test("with no audit capability composed, a tool call still succeeds and nothing is written", async () => {
    const app = buildApp();
    const { tokens, userId } = await connected(app);
    emitter = "absent";
    emitted.length = 0;
    const read = await rpc(app, tokens.access_token, "tools/call", {
      name: "notes_notes_read",
      arguments: { path: { id: "n1" } },
    });
    expect(read.body.result).toMatchObject({ isError: false, structuredContent: { id: "n1" } });
    expect(seen).toEqual([{ route: "read", userId }]);
    expect(emitted).toEqual([]);
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
      verifiedHost: null,
      reportedName: "POWERPLAY Official Sync",
      reportedUri: null,
      redirectUri: REDIRECT,
    });
    expect(view.capabilities).toEqual([
      expect.objectContaining({
        capability: "notes",
        reachable: 1,
        total: 3,
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

describe("a client identified by its metadata document", () => {
  const DOCUMENT_URL = "https://client.example.com/oauth/client.json";
  /** Every request the stubbed network saw. */
  const fetched: string[] = [];

  /** The document a well-behaved client serves at its own id. */
  const documentFor = (clientId: string, overrides: Record<string, unknown> = {}) => ({
    client_id: clientId,
    client_name: "Canary Agent",
    client_uri: "https://client.example.com",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...overrides,
  });

  /** The network, as a Worker reaches it: whatever `answer` returns for each URL. */
  function network(answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      fetched.push(url);
      return answer(url, init);
    });
  }

  /** Serve one document at {@link DOCUMENT_URL}. */
  function serve(body: unknown, headers: Record<string, string> = {}) {
    network(
      () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json", ...headers },
        }),
    );
  }

  /** Start an authorization for `clientId`, and answer the provider's response as it came. */
  async function startAuthorization(
    app: App,
    clientId: string,
    session: string,
    verifier: string,
    redirect = REDIRECT,
  ): Promise<Response> {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      scope: "mcp offline_access",
      state: "s1",
      code_challenge: await challengeOf(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE,
    });
    return call(app, `/auth/oauth2/authorize?${query}`, {
      headers: { authorization: `Bearer ${session}` },
      redirect: "manual",
    });
  }

  /** The authorization was refused for `reason`: no consent screen, and so no code. */
  async function expectRefused(res: Response, reason: RegExp): Promise<void> {
    const location = res.headers.get("location") ?? "";
    const answer = `${res.status} ${decodeURIComponent(location.replace(/\+/g, " "))} ${await res.clone().text()}`;
    expect(location, answer).not.toContain("/agent-consent?");
    expect(location, answer).not.toContain("code=");
    expect(answer).toMatch(reason);
  }

  beforeEach(() => {
    fetched.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("the authorization server's metadata says it takes a metadata document as a client id", async () => {
    const metadata = (await (await call(buildApp(), "/.well-known/oauth-authorization-server/auth")).json()) as {
      client_id_metadata_document_supported?: boolean;
      registration_endpoint?: string;
    };
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    // Dynamic registration serves a client that speaks nothing else.
    expect(metadata.registration_endpoint).toBe(`${SCOPED_ORIGIN}/auth/oauth2/register`);
  });

  test("authorize with its URL as the id, approve on a screen naming its verified host, exchange, and call", async () => {
    serve(documentFor(DOCUMENT_URL));
    const app = buildApp();
    const { token: session, userId } = await signInScoped(env.DB, "cimd@test.com");
    const verifier = `verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const started = await startAuthorization(app, DOCUMENT_URL, session, verifier);
    const location = started.headers.get("location") ?? "";
    expect(location, `${started.status} ${await started.clone().text()}`).toContain("/agent-consent?");
    const oauthQuery = location.slice(location.indexOf("?") + 1);
    expect(fetched).toContain(DOCUMENT_URL);

    const consent = await call(app, `/mcp/consent?oauth_query=${encodeURIComponent(oauthQuery)}`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(((await consent.json()) as { client: unknown }).client).toEqual({
      id: DOCUMENT_URL,
      verifiedHost: "client.example.com",
      reportedName: "Canary Agent",
      reportedUri: "https://client.example.com",
      redirectUri: REDIRECT,
    });

    const tokens = await approveAndExchange(app, DOCUMENT_URL, session, oauthQuery, verifier);
    const claims = JSON.parse(
      atob((tokens.access_token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    ) as Record<string, unknown>;
    expect(claims.aud).toBe(RESOURCE);
    expect(claims.sub).toBe(userId);
    const read = await rpc(app, tokens.access_token, "tools/call", {
      name: "notes_notes_read",
      arguments: { path: { id: "n1" } },
    });
    expect(read.body.result).toMatchObject({ isError: false, structuredContent: { id: "n1" } });
    expect(seen).toEqual([{ route: "read", userId }]);
  });

  test("the code is bound to its PKCE challenge: the wrong verifier gets no token", async () => {
    serve(documentFor(DOCUMENT_URL));
    const app = buildApp();
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    const verifier = `verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const started = await startAuthorization(app, DOCUMENT_URL, session, verifier);
    const location = started.headers.get("location") ?? "";
    const decided = await decideOn(app, session, location.slice(location.indexOf("?") + 1), true);
    const code = new URL(((await decided.json()) as { redirect: string }).redirect).searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    const token = await call(app, "/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: DOCUMENT_URL,
        code_verifier: `wrong-${verifier}`,
        resource: RESOURCE,
      }).toString(),
    });
    expect(token.status).toBeGreaterThanOrEqual(400);
  });

  test("a document whose client_id is not its own URL is refused", async () => {
    serve(documentFor("https://impostor.example.com/oauth/client.json"));
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    await expectRefused(
      await startAuthorization(buildApp(), DOCUMENT_URL, session, "v".repeat(48)),
      /does not match the metadata document URL/,
    );
    expect(fetched).toEqual([DOCUMENT_URL]);
  });

  test("a client id that is not HTTPS is refused, and nothing is fetched", async () => {
    serve(documentFor("http://client.example.com/oauth/client.json"));
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    const res = await startAuthorization(
      buildApp(),
      "http://client.example.com/oauth/client.json",
      session,
      "v".repeat(48),
    );
    await expectRefused(res, /invalid_client/);
    expect(fetched).toEqual([]);
  });

  test("a client id on a private, link-local or loopback address is refused, and nothing is fetched", async () => {
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    const app = buildApp();
    for (const clientId of [
      "https://10.0.0.7/oauth/client.json",
      "https://192.168.1.10/oauth/client.json",
      "https://169.254.169.254/latest/meta-data",
      "https://[fe80::1]/oauth/client.json",
      "https://127.0.0.1/oauth/client.json",
      "https://localhost/oauth/client.json",
    ]) {
      serve(documentFor(clientId));
      await expectRefused(
        await startAuthorization(app, clientId, session, "v".repeat(48)),
        /private or reserved address/,
      );
    }
    expect(fetched).toEqual([]);
  });

  test("an oversized document is refused", async () => {
    serve(documentFor(DOCUMENT_URL, { client_name: "A".repeat(6 * 1024) }));
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    await expectRefused(await startAuthorization(buildApp(), DOCUMENT_URL, session, "v".repeat(48)), /exceeds 5KB/);
    expect(fetched).toEqual([DOCUMENT_URL]);
  });

  test("a document that answers too slowly is refused", { timeout: 20_000 }, async () => {
    network(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    await expectRefused(await startAuthorization(buildApp(), DOCUMENT_URL, session, "v".repeat(48)), /timed out/);
    expect(fetched).toEqual([DOCUMENT_URL]);
  });

  test("a document behind a redirect is refused, and the redirect is not followed", async () => {
    network(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/c.json" } }));
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    await expectRefused(
      await startAuthorization(buildApp(), DOCUMENT_URL, session, "v".repeat(48)),
      /returned HTTP 302/,
    );
    expect(fetched).toEqual([DOCUMENT_URL]);
  });

  test("a redirect URI the document does not list is refused", async () => {
    serve(documentFor(DOCUMENT_URL));
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    const res = await startAuthorization(
      buildApp(),
      DOCUMENT_URL,
      session,
      "v".repeat(48),
      "https://attacker.example.net/callback",
    );
    await expectRefused(res, /invalid redirect uri/);
    expect(res.headers.get("location") ?? "").not.toContain("attacker.example.net");
  });

  /** Move the clock the metadata cache reads forward by `ms`, from wherever it stands now. */
  function advanceClock(ms: number): void {
    const now = Date.now() + ms;
    vi.spyOn(Date, "now").mockReturnValue(now);
  }

  /** Authorize `attempts` times on one composed app, and expect each to reach the consent screen. */
  async function authorizeRepeatedly(app: App, session: string, label: string, attempts = 1): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const res = await startAuthorization(app, DOCUMENT_URL, session, `v-${label}-${attempt}-${"x".repeat(48)}`);
      expect(res.headers.get("location") ?? "", `${label}, attempt ${attempt}`).toContain("/agent-consent?");
    }
  }

  test("a document is fetched once while its max-age says it is fresh, and again once it has passed", async () => {
    serve(documentFor(DOCUMENT_URL), { "cache-control": "max-age=300" });
    const app = buildApp();
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    await authorizeRepeatedly(app, session, "fresh", 2);
    expect(fetched).toEqual([DOCUMENT_URL]);
    advanceClock(301_000);
    await authorizeRepeatedly(app, session, "stale");
    expect(fetched).toEqual([DOCUMENT_URL, DOCUMENT_URL]);
  });

  test("a document served no-store is fetched on every authorization", async () => {
    serve(documentFor(DOCUMENT_URL), { "cache-control": "no-store" });
    const app = buildApp();
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    await authorizeRepeatedly(app, session, "no-store", 2);
    expect(fetched).toEqual([DOCUMENT_URL, DOCUMENT_URL]);
  });

  test("a document is fetched again after 60 minutes, however long its caching headers say it is fresh", async () => {
    serve(documentFor(DOCUMENT_URL), { "cache-control": "max-age=86400" });
    const app = buildApp();
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    await authorizeRepeatedly(app, session, "first");
    advanceClock(59 * 60_000);
    await authorizeRepeatedly(app, session, "within the ceiling");
    expect(fetched).toEqual([DOCUMENT_URL]);
    advanceClock(2 * 60_000);
    await authorizeRepeatedly(app, session, "past the ceiling");
    expect(fetched).toEqual([DOCUMENT_URL, DOCUMENT_URL]);
  });

  test("dynamic registration still works beside it, and its client is never shown as verified", async () => {
    const app = buildApp();
    const { token: session } = await signInScoped(env.DB, "dcr@test.com");
    const clientId = await register(app);
    const oauthQuery = await authorize(app, clientId, session, `v-${crypto.randomUUID()}-${crypto.randomUUID()}`);
    const consent = await call(app, `/mcp/consent?oauth_query=${encodeURIComponent(oauthQuery)}`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(((await consent.json()) as { client: { verifiedHost: unknown } }).client.verifiedHost).toBeNull();
  });

  test("the connected-applications list names its verified host, and revoking it by its URL works", async () => {
    serve(documentFor(DOCUMENT_URL));
    const app = buildApp();
    const { token: session } = await signInScoped(env.DB, "cimd@test.com");
    const verifier = `verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const started = await startAuthorization(app, DOCUMENT_URL, session, verifier);
    const location = started.headers.get("location") ?? "";
    const tokens = await approveAndExchange(
      app,
      DOCUMENT_URL,
      session,
      location.slice(location.indexOf("?") + 1),
      verifier,
    );
    const listed = await call(app, "/mcp/connections", { headers: { authorization: `Bearer ${session}` } });
    expect(((await listed.json()) as { applications: unknown[] }).applications).toEqual([
      expect.objectContaining({
        clientId: DOCUMENT_URL,
        verifiedHost: "client.example.com",
        reportedName: "Canary Agent",
      }),
    ]);
    const revoked = await call(app, `/mcp/connections/${encodeURIComponent(DOCUMENT_URL)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session}`, origin: SCOPED_ORIGIN },
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect((await rpc(app, tokens.access_token, "tools/list")).status).toBe(401);
  });
});
