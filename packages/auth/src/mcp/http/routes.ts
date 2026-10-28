// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { grantedEntitlementKeys } from "@pithy-sh/core/src/entitlement/entitlement";
import { HttpError, pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import {
  ForbiddenError,
  NotFoundError,
  PithyError,
  UnauthorizedError,
  ValidationError,
} from "@pithy-sh/core/src/error/pithyError";
import { AuthContext } from "@pithy-sh/core/src/http/authContext";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";
import { validate } from "@pithy-sh/core/src/http/validation";
import { type AppTool, offeredTools } from "@pithy-sh/core/src/mcp/tools";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { AuthAuditActions } from "../../audit/actions";
import { authDatabase } from "../../data/tables";
import { requireAuth } from "../../http/middleware";
import { resolveDb } from "../../http/resolve";
import type { AuthInstance } from "../../instance/auth";
import { lifecycleRefusalFor } from "../../lifecycle/enforce";
import { PACKAGE_VERSION } from "../../version.generated";
import { argumentClass } from "../argumentClass";
import { consentView } from "../consent";
import { dispatchedOutcome, dispatchRequest, type ToolArguments, toolArguments } from "../dispatch";
import { floorAdmits, type McpFloor } from "../floor";
import type { McpHost } from "../host";
import { MCP_SCOPE, MCP_SCOPES } from "../provider";
import { answer } from "../rpc";
import {
  recordToolCall,
  requestedToolName,
  type ToolCallActor,
  type ToolCallCorrelation,
  type ToolCallResult,
  toolCallEvent,
} from "../toolAudit";
import { redirectList } from "./redirectList";
import {
  AuthorizationServerMetadata,
  type ConnectedApplication,
  ConnectedApplications,
  ConsentDecision,
  ConsentView,
  ProtectedResourceMetadata,
  RevokedApplication,
  RpcResponse,
} from "./responses";
import { ConnectionParam, ConsentBody, ConsentQuery, McpRequestBody } from "./schemas";

/**
 * The MCP capability's routes (`docs/AGENT-ACCESS.md` §4).
 *
 * - `POST <path>` — the MCP endpoint. A bearer token minted for this endpoint, and nothing else, gets in.
 * - `GET|DELETE <path>` — 405. The endpoint is stateless: it opens no event stream and holds no session to end.
 * - `GET /.well-known/oauth-protected-resource<path>` — where a client learns which authorization server to ask.
 * - `GET /.well-known/oauth-authorization-server<basePath>` — that server's metadata, at the RFC 8414 address.
 * - `GET|POST <path>/consent` — what the scaffolded consent screen reads, and the one decision it sends.
 * - `GET <path>/connections`, `DELETE <path>/connections/:clientId` — what the user approved, and the revoke.
 */

/** What the routes are built over. Read lazily: the host and the router exist only once `createBackend` has run. */
export interface McpRouteDeps {
  readonly path: string;
  readonly floor: McpFloor;
  readonly host: () => McpHost;
  readonly app: () => Hono<PithyHonoEnv>;
  readonly tools: () => readonly AppTool[];
}

/** A verified MCP caller: who, through which client, for which organization, and what their role allows. */
interface VerifiedCaller {
  readonly auth: AuthContext;
  readonly clientId: string;
  readonly tenant: string | null;
  readonly roleAllows: ((power: string) => boolean) | null;
}

/** A verified caller, and when their request arrived. */
interface McpCaller extends VerifiedCaller {
  readonly receivedAt: number;
}

/** Each MCP request's verified caller, set by {@link mcpCallerGuard} and read by the endpoint's handler. */
const callers = new WeakMap<Request, McpCaller>();

/** The key set `verifyJwsAccessToken` takes. */
type JwksSet = Awaited<ReturnType<Exclude<Parameters<typeof verifyJwsAccessToken>[1]["jwksFetch"], string>>>;

/**
 * The provider's endpoints this module calls. `AuthInstance` is typed over the kit's own plugins, so the ones a
 * composed provider adds are absent from its type; this names the two, as the provider declares them.
 */
interface ProviderApi {
  getJwks(): Promise<unknown>;
  getOAuthServerConfig(): Promise<unknown>;
}

function providerApi(instance: AuthInstance): ProviderApi {
  return instance.api as unknown as ProviderApi;
}

/** The provider's database, through Better Auth's own adapter — which maps the models to the `pithy_mcp_*` tables. */
async function adapterOf(instance: AuthInstance) {
  return (await instance.$context).adapter;
}

/** The MCP endpoint's absolute URL for this request, and the issuer that mints its tokens. */
function addresses(c: Context<PithyHonoEnv>, deps: McpRouteDeps): { resource: string; issuer: string; base: string } {
  const host = deps.host();
  const base = host.baseURL(c.req.raw).replace(/\/$/, "");
  return { base, resource: `${base}${deps.path}`, issuer: `${base}${host.basePath}` };
}

/** The protected-resource metadata URL a challenge names. */
function metadataUrl(base: string, path: string): string {
  return `${base}/.well-known/oauth-protected-resource${path}`;
}

/** The refusal an unauthenticated MCP request gets: a 401 naming where to find the authorization server. */
function challenge(c: Context<PithyHonoEnv>, deps: McpRouteDeps, detail: string): Response {
  const { base } = addresses(c, deps);
  const response = pithyErrorHandler(
    new UnauthorizedError({
      message: "Authentication required.",
      action: "Authorize the MCP client against this application, then retry with its access token.",
      detail,
    }),
    c,
  );
  response.headers.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${metadataUrl(base, deps.path)}", scope="${MCP_SCOPE}"`,
  );
  return response;
}

function claim(payload: Record<string, unknown>, name: string): string | undefined {
  const value = payload[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Verify the caller, or answer the refusal. **Identity only — never permission.** The token proves who and through
 * which client; it is checked for its signature, issuer, audience and expiry, for a consent still on record, for a
 * session still live, and for an account in good standing. What the caller may *do* is never read off it.
 */
async function verifyCaller(c: Context<PithyHonoEnv>, deps: McpRouteDeps): Promise<VerifiedCaller | Response> {
  const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim();
  if (!bearer) return challenge(c, deps, "no bearer token on the MCP request");
  const host = deps.host();
  const instance = await host.instance(c);
  const { resource, issuer } = addresses(c, deps);
  let payload: Record<string, unknown>;
  try {
    payload = (await verifyJwsAccessToken(bearer, {
      jwksFetch: async () => (await providerApi(instance).getJwks()) as JwksSet,
      verifyOptions: { audience: resource, issuer },
    })) as Record<string, unknown>;
  } catch {
    return challenge(c, deps, "the MCP access token did not verify for this resource");
  }
  const userId = claim(payload, "sub");
  const sessionId = claim(payload, "sid");
  const clientId = claim(payload, "azp") ?? claim(payload, "client_id");
  if (!userId || !sessionId || !clientId)
    return challenge(c, deps, "the MCP access token names no user, session or client");
  const adapter = await adapterOf(instance);
  // Revocation is immediate: the connected-applications screen deletes the consent, and every token minted under it
  // stops here on its next call rather than living out its hour.
  const consent = await adapter.findOne({
    model: "oauthConsent",
    where: [
      { field: "clientId", value: clientId },
      { field: "userId", value: userId },
    ],
  });
  if (!consent) return challenge(c, deps, `client ${clientId} holds no consent from user ${userId}`);
  const session = await adapter.findOne<{ expiresAt: Date | string }>({
    model: "session",
    where: [{ field: "id", value: sessionId }],
  });
  const now = new Date();
  if (!session || new Date(session.expiresAt).getTime() <= now.getTime()) {
    return challenge(c, deps, `session ${sessionId} the token was minted under has ended`);
  }
  const refusal = await lifecycleRefusalFor(authDatabase(resolveDb(c.env, host.database)), userId, null, now);
  if (refusal) throw refusal;
  const auth = AuthContext.parse({ userId, sessionId, scopes: [], locale: null });
  c.set("auth", auth);
  const acting = await c.var.actingOrganization();
  const roleAllows = acting === null ? null : (power: string) => acting.roleAllows(power);
  const admitted = await floorAdmits(deps.floor, {
    roleAllows,
    entitlements: async () => grantedEntitlementKeys(await c.var.entitlements.list(), now),
  });
  if (!admitted) {
    throw new ForbiddenError({
      message: "Your account cannot connect an agent to this application.",
      detail: `user ${userId} is below the MCP endpoint's floor`,
    });
  }
  return { auth, clientId, tenant: acting?.organizationId ?? null, roleAllows };
}

/**
 * The MCP endpoint's guard: the caller verified, or the refusal. A guard rather than a step inside the handler, so it
 * runs before the body is validated — an unauthenticated client gets the challenge that names the authorization
 * server, whatever it sent, and learns nothing about which bodies are well-formed.
 */
function mcpCallerGuard(deps: McpRouteDeps): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    const receivedAt = Date.now();
    const caller = await verifyCaller(c, deps);
    if (caller instanceof Response) return caller;
    callers.set(c.req.raw, { ...caller, receivedAt });
    await next();
  };
}

/** What a request's tool-call row and its route's rows are joined by, and where the call came from. */
function correlationOf(c: Context<PithyHonoEnv>): ToolCallCorrelation {
  return {
    requestId: c.req.header("cf-ray") ?? crypto.randomUUID(),
    ip: c.req.header("cf-connecting-ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
}

/** The correlation, as the headers the dispatched request carries to the route. */
function correlationHeaders(correlation: ToolCallCorrelation): Record<string, string> {
  return {
    "cf-ray": correlation.requestId,
    ...(correlation.ip === null ? {} : { "cf-connecting-ip": correlation.ip }),
    ...(correlation.userAgent === null ? {} : { "user-agent": correlation.userAgent }),
  };
}

/** One tool call, through the whole app, as the caller. */
async function callTool(
  c: Context<PithyHonoEnv>,
  deps: McpRouteDeps,
  caller: McpCaller,
  correlation: ToolCallCorrelation,
  tool: AppTool,
  args: ToolArguments,
): Promise<{ status: number; body: unknown; bytes: number }> {
  let request: Request;
  try {
    request = dispatchRequest(new URL(c.req.url).origin, tool, args, caller.auth, correlationHeaders(correlation));
  } catch (error) {
    // Arguments that build no request to the tool's route are the agent's to correct, so they are answered as the
    // route would answer them, inside a tool result, rather than as an HTTP failure of the transport.
    if (!(error instanceof PithyError)) throw error;
    const body = { error: HttpError.encode(error.payload) };
    return { status: error.payload.status, body, bytes: new TextEncoder().encode(JSON.stringify(body)).byteLength };
  }
  let executionCtx: ExecutionContext | undefined;
  try {
    executionCtx = c.executionCtx as unknown as ExecutionContext;
  } catch {
    executionCtx = undefined;
  }
  return dispatchedOutcome(await deps.app().fetch(request, c.env, executionCtx));
}

/** Who a tool-call row names: the caller, and the client's name as it registered itself. */
async function toolCallActor(c: Context<PithyHonoEnv>, deps: McpRouteDeps, caller: McpCaller): Promise<ToolCallActor> {
  const client = await (await adapterOf(await deps.host().instance(c))).findOne<{ name?: string | null }>({
    model: "oauthClient",
    where: [{ field: "clientId", value: caller.clientId }],
  });
  return {
    userId: caller.auth.userId,
    sessionId: caller.auth.sessionId,
    clientId: caller.clientId,
    clientReportedName: client?.name ?? null,
    tenant: caller.tenant,
  };
}

/** Write the row for one tool call. Never fails the call. */
function auditToolCall(
  c: Context<PithyHonoEnv>,
  deps: McpRouteDeps,
  caller: McpCaller,
  correlation: ToolCallCorrelation,
  tool: string | null,
  result: ToolCallResult,
): Promise<void> {
  const durationMs = Date.now() - caller.receivedAt;
  return recordToolCall(c.var.emit, async () =>
    toolCallEvent({ actor: await toolCallActor(c, deps, caller), correlation, tool, durationMs, result }),
  );
}

/** One tool call, made and recorded. */
async function auditedCall(
  c: Context<PithyHonoEnv>,
  deps: McpRouteDeps,
  caller: McpCaller,
  correlation: ToolCallCorrelation,
  tool: AppTool,
  raw: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const args = toolArguments(raw);
  const classed = argumentClass(tool.path, args);
  let outcome: { status: number; body: unknown; bytes: number };
  try {
    outcome = await callTool(c, deps, caller, correlation, tool, args);
  } catch (error) {
    await auditToolCall(c, deps, caller, correlation, tool.name, {
      kind: "answered",
      status: 500,
      responseBytes: 0,
      arguments: classed,
    });
    throw error;
  }
  await auditToolCall(c, deps, caller, correlation, tool.name, {
    kind: "answered",
    status: outcome.status,
    responseBytes: outcome.bytes,
    arguments: classed,
  });
  return outcome;
}

/** Emit one consent event. Never fatal: the audit seam swallows its own failures. */
async function audit(c: Context<PithyHonoEnv>, event: Omit<AuditEventInput, "actorType">): Promise<void> {
  await c.var.emit({
    actorType: "user",
    actorId: c.var.auth?.userId ?? null,
    sessionId: c.var.auth?.sessionId ?? null,
    ip: c.req.header("cf-connecting-ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    ...event,
  });
}

/**
 * Hand the decision to the provider's own consent endpoint, as the browser's request — its session credential and
 * its origin — so every check the provider makes on a consent runs here unchanged. It needs the request itself,
 * which a direct `api` call does not carry.
 */
async function decide(
  c: Context<PithyHonoEnv>,
  deps: McpRouteDeps,
  instance: AuthInstance,
  body: { accept: boolean; oauth_query: string },
): Promise<{ url: string }> {
  const { issuer } = addresses(c, deps);
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const response = await instance.handler(
    new Request(`${issuer}/oauth2/consent`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
  const decided = (await response.json().catch(() => ({}))) as { url?: unknown };
  if (!response.ok || typeof decided.url !== "string") {
    throw new ValidationError({
      message: "This authorization request could not be completed. Start again from the application.",
      detail: `the provider answered the consent with ${response.status}`,
    });
  }
  return { url: decided.url };
}

/** The signed authorization query, verified, as parameters. */
async function signedQuery(instance: AuthInstance, raw: string): Promise<URLSearchParams> {
  const query = raw.startsWith("?") ? raw.slice(1) : raw;
  const secret = (await instance.$context).secret;
  if (!(await verifyOAuthQueryParams(query, secret))) {
    throw new ValidationError({
      message: "This authorization request has expired. Start again from the application.",
      detail: "the consent screen's oauth_query did not verify or has expired",
    });
  }
  return new URLSearchParams(query);
}

/** The caller's role, as a `ToolCaller` reads it. */
async function roleOf(c: Context<PithyHonoEnv>): Promise<((power: string) => boolean) | null> {
  const acting = await c.var.actingOrganization();
  return acting === null ? null : (power: string) => acting.roleAllows(power);
}

/** Register every route. */
export function registerMcpRoutes(app: Hono<PithyHonoEnv>, deps: McpRouteDeps): void {
  const { path } = deps;
  const csrf = requireSameOrigin();

  const protectedResource = (c: Context<PithyHonoEnv>) => {
    const { resource, issuer } = addresses(c, deps);
    return c.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "This application's MCP endpoint",
    } satisfies ProtectedResourceMetadata);
  };
  const protectedResourceSpec = describeRoute({
    summary: "Name the authorization server for the MCP endpoint.",
    description: "RFC 9728 protected-resource metadata. Where an MCP client starts, from the endpoint's URL alone.",
    verification: "public",
    responses: { 200: ProtectedResourceMetadata },
  });
  app.get(`/.well-known/oauth-protected-resource${path}`, protectedResourceSpec, protectedResource);
  app.get("/.well-known/oauth-protected-resource", protectedResourceSpec, protectedResource);

  const serverMetadata = async (c: Context<PithyHonoEnv>) => {
    const instance = await deps.host().instance(c);
    const metadata = (await providerApi(instance).getOAuthServerConfig()) as AuthorizationServerMetadata;
    return c.json(metadata satisfies AuthorizationServerMetadata);
  };
  const serverMetadataSpec = describeRoute({
    summary: "Describe the authorization server that mints MCP tokens.",
    description: "RFC 8414 authorization-server metadata, at the address its issuer implies.",
    verification: "public",
    responses: { 200: AuthorizationServerMetadata },
  });
  // The issuer carries auth's base path, so RFC 8414 puts its metadata at the well-known prefix plus that path. A
  // client that drops the path asks the bare address; both answer, and both answer for this Worker's one issuer.
  app.get(`/.well-known/oauth-authorization-server${deps.host().basePath}`, serverMetadataSpec, serverMetadata);
  app.get("/.well-known/oauth-authorization-server", serverMetadataSpec, serverMetadata);

  app.post(
    path,
    describeRoute({
      summary: "Serve the app's MCP tools to an agent acting as a user.",
      description:
        "Streamable HTTP, stateless, one JSON-RPC message per request answered in the body. The bearer token must be one this application minted for this endpoint. `tools/list` holds only what the caller's role allows, and every call runs through the route it names, as the caller.",
      verification: "bearer",
      responses: {
        200: RpcResponse,
        202: { description: "A notification, accepted. No body." },
      },
    }),
    mcpCallerGuard(deps),
    validate("json", McpRequestBody),
    async (c) => {
      const caller = callers.get(c.req.raw);
      if (caller === undefined) return challenge(c, deps, "the MCP request reached its handler unverified");
      const correlation = correlationOf(c);
      const reply = await answer(c.req.valid("json"), {
        server: { name: "pithy", version: PACKAGE_VERSION },
        tools: async () => offeredTools(deps.tools(), { roleAllows: caller.roleAllows, scopes: caller.auth.scopes }),
        call: (tool, args) => auditedCall(c, deps, caller, correlation, tool, args),
        refused: (name) =>
          auditToolCall(c, deps, caller, correlation, requestedToolName(name), {
            kind: "refused",
            reason: deps.tools().some((tool) => tool.name === name) ? "withheld" : "unknown",
          }),
      });
      if (reply === null) return c.body(null, 202);
      return c.json(reply as RpcResponse);
    },
  );

  // The streamable HTTP transport requires a GET on the endpoint to answer an event stream or 405, and a client that
  // gets anything else reports the endpoint broken. DELETE ends a transport session, and this endpoint keeps none.
  app.on(
    ["GET", "DELETE"],
    path,
    describeRoute({
      summary: "Refuse to open an event stream or end a session on the MCP endpoint.",
      description:
        "The endpoint is stateless and answers every message in the response body, so it offers no server-sent event stream and has no session to end. Always 405, with `Allow: POST`.",
      verification: "public",
      responses: { 405: { description: "Only POST is served here." } },
    }),
    (c) => c.body(null, 405, { Allow: "POST" }),
  );

  app.get(
    `${path}/consent`,
    describeRoute({
      summary: "Show what an application asking to act as you will be able to do.",
      description:
        "Read by the scaffolded consent screen. The client's name is as it reported itself; the redirect URI is the one the authorization server enforces. Only operations your role allows are listed.",
      verification: ["bearer", "session"],
      responses: { 200: ConsentView },
    }),
    requireAuth(),
    validate("query", ConsentQuery),
    async (c) => {
      const instance = await deps.host().instance(c);
      const query = await signedQuery(instance, c.req.valid("query").oauth_query);
      const clientId = query.get("client_id") ?? "";
      const client = await (await adapterOf(instance)).findOne<{ name?: string | null; uri?: string | null }>({
        model: "oauthClient",
        where: [{ field: "clientId", value: clientId }],
      });
      if (!client) throw new NotFoundError({ message: "No such application.", detail: `client ${clientId}` });
      const caller = { roleAllows: await roleOf(c), scopes: c.var.auth?.scopes ?? [] };
      const view = consentView({
        client: {
          id: clientId,
          reportedName: client.name ?? null,
          reportedUri: client.uri ?? null,
          redirectUri: query.get("redirect_uri") ?? "",
        },
        tools: deps.tools(),
        caller,
        requestedScopes: (query.get("scope") ?? "").split(" ").filter((scope) => scope.length > 0),
      });
      return c.json(view satisfies ConsentView);
    },
  );

  app.post(
    `${path}/consent`,
    describeRoute({
      summary: "Let an application act as you in this application, or refuse it.",
      description:
        "One decision for the whole request; nothing is selectable. Approving is audited as `auth/mcp_grant_approved`, refusing as `auth/mcp_grant_denied`. Answers where to send the browser next.",
      verification: ["bearer", "session"],
      responses: { 200: ConsentDecision },
    }),
    requireAuth(),
    csrf,
    validate("json", ConsentBody),
    async (c) => {
      const { oauth_query, accept } = c.req.valid("json");
      const instance = await deps.host().instance(c);
      const query = await signedQuery(instance, oauth_query);
      const decided = await decide(c, deps, instance, { accept, oauth_query: query.toString() });
      const redirect = decided.url;
      const clientId = query.get("client_id") ?? "";
      await audit(c, {
        action: accept ? AuthAuditActions.mcpGrantApproved : AuthAuditActions.mcpGrantDenied,
        outcome: "success",
        resourceType: "mcp_client",
        resourceId: clientId,
        metadata: { redirectUri: query.get("redirect_uri") ?? null, scope: query.get("scope") ?? null },
      });
      return c.json({ redirect } satisfies ConsentDecision);
    },
  );

  app.get(
    `${path}/connections`,
    describeRoute({
      summary: "List the applications acting as you.",
      description: "What you approved, when, and where each sends its tokens. Revoking is the only narrowing there is.",
      verification: ["bearer", "session"],
      responses: { 200: ConnectedApplications },
    }),
    requireAuth(),
    async (c) => {
      const userId = c.var.auth?.userId ?? "";
      const adapter = await adapterOf(await deps.host().instance(c));
      const consents = await adapter.findMany<{ clientId: string; createdAt: Date | string }>({
        model: "oauthConsent",
        where: [{ field: "userId", value: userId }],
      });
      const applications: ConnectedApplication[] = [];
      for (const consent of consents) {
        const client = await adapter.findOne<{ name?: string | null; redirectUris?: string[] | string | null }>({
          model: "oauthClient",
          where: [{ field: "clientId", value: consent.clientId }],
        });
        const uris = client?.redirectUris;
        applications.push({
          clientId: consent.clientId,
          reportedName: client?.name ?? null,
          redirectUris: Array.isArray(uris) ? uris : typeof uris === "string" ? redirectList(uris) : [],
          approvedAt: new Date(consent.createdAt).toISOString(),
        });
      }
      applications.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
      return c.json({ applications } satisfies ConnectedApplications);
    },
  );

  app.delete(
    `${path}/connections/:clientId`,
    describeRoute({
      summary: "Revoke an application acting as you.",
      description:
        "Takes effect on its next call: the consent, its refresh tokens and its stored access tokens go, and the MCP endpoint refuses a token with no consent behind it. Audited as `auth/mcp_grant_revoked`. No administrator needed.",
      verification: ["bearer", "session"],
      responses: { 200: RevokedApplication },
    }),
    requireAuth(),
    csrf,
    validate("param", ConnectionParam),
    async (c) => {
      const userId = c.var.auth?.userId ?? "";
      const { clientId } = c.req.valid("param");
      const adapter = await adapterOf(await deps.host().instance(c));
      const where = [
        { field: "clientId", value: clientId },
        { field: "userId", value: userId },
      ];
      const held = await adapter.findMany({ model: "oauthConsent", where });
      if (held.length === 0) {
        throw new NotFoundError({
          message: "No such connected application.",
          detail: `client ${clientId} for ${userId}`,
        });
      }
      await adapter.deleteMany({ model: "oauthConsent", where });
      await adapter.deleteMany({ model: "oauthRefreshToken", where });
      await adapter.deleteMany({ model: "oauthAccessToken", where });
      await audit(c, {
        action: AuthAuditActions.mcpGrantRevoked,
        outcome: "success",
        resourceType: "mcp_client",
        resourceId: clientId,
      });
      return c.json({ revoked: true } satisfies RevokedApplication);
    },
  );
}
