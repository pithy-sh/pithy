// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type AuthClientOptions, type AuthResult, callAuth } from "./api";

/**
 * The browser half of the MCP capability's two screens: the consent screen and connected applications.
 *
 * Every call goes through {@link callAuth}, the one producer of a same-origin request, with the base path pointed
 * at the MCP endpoint instead of auth's. **Zod-free**, like everything on this side of the wire: each answer is
 * narrowed by a hand-written guard, because this compiles into an adopter's browser bundle.
 */

/** Where the MCP capability mounts unless configured otherwise. */
export const MCP_BASE_PATH = "/mcp";

/** One operation a consent row lists. */
export interface ConsentOperation {
  readonly tool: string;
  readonly summary: string;
  readonly effect: "writes" | "sends" | "charges" | "deletes" | null;
}

/** One capability, as the unit of consent. */
export interface ConsentCapability {
  readonly capability: string;
  readonly operations: readonly ConsentOperation[];
  readonly reachable: number;
  readonly total: number;
  readonly effects: {
    readonly writes: number;
    readonly sends: number;
    readonly charges: number;
    readonly deletes: number;
  };
}

/** Everything the consent screen shows. See the server's `ConsentView`. */
export interface ConsentView {
  readonly client: {
    readonly id: string;
    /** The host its metadata document proved it by. Absent or `null` when nothing verified it. */
    readonly verifiedHost?: string | null;
    readonly reportedName: string | null;
    readonly reportedUri: string | null;
    readonly redirectUri: string;
  };
  readonly capabilities: readonly ConsentCapability[];
  readonly requested: readonly {
    readonly scope: string;
    readonly granted: boolean;
    readonly reason: "role" | "unknown" | null;
  }[];
}

/** One application acting as the user. */
export interface ConnectedApplication {
  readonly clientId: string;
  /** The host its metadata document proved it by. Absent or `null` when nothing verified it. */
  readonly verifiedHost?: string | null;
  readonly reportedName: string | null;
  readonly redirectUris: readonly string[];
  readonly approvedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConsentView(value: unknown): value is ConsentView {
  return (
    isRecord(value) &&
    isRecord(value.client) &&
    typeof value.client.id === "string" &&
    typeof value.client.redirectUri === "string" &&
    Array.isArray(value.capabilities) &&
    Array.isArray(value.requested)
  );
}

function isDecision(value: unknown): value is { redirect: string } {
  return isRecord(value) && typeof value.redirect === "string";
}

function isConnections(value: unknown): value is { applications: ConnectedApplication[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.applications) &&
    value.applications.every((entry) => isRecord(entry) && typeof entry.clientId === "string")
  );
}

function isRevoked(value: unknown): value is { revoked: true } {
  return isRecord(value) && value.revoked === true;
}

/** The options a call runs with: the MCP base path, unless the caller named another. */
function mcpOptions(options: AuthClientOptions | undefined): AuthClientOptions {
  return { ...options, basePath: options?.basePath ?? MCP_BASE_PATH };
}

/** What the application asking for access will be able to do. `oauthQuery` is the screen's own query string. */
export function readConsent(oauthQuery: string, options?: AuthClientOptions): Promise<AuthResult<ConsentView>> {
  const query = new URLSearchParams({ oauth_query: oauthQuery.replace(/^\?/, "") });
  return callAuth(`/consent?${query}`, { method: "GET" }, mcpOptions(options), isConsentView);
}

/** The one decision. Answers where to send the browser: the application's redirect, with a code or a refusal. */
export function decideConsent(
  oauthQuery: string,
  accept: boolean,
  options?: AuthClientOptions,
): Promise<AuthResult<{ redirect: string }>> {
  return callAuth(
    "/consent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oauth_query: oauthQuery.replace(/^\?/, ""), accept }),
    },
    mcpOptions(options),
    isDecision,
  );
}

/** Every application acting as the signed-in user, newest first. */
export async function listConnectedApplications(
  options?: AuthClientOptions,
): Promise<AuthResult<readonly ConnectedApplication[]>> {
  const result = await callAuth("/connections", { method: "GET" }, mcpOptions(options), isConnections);
  return result.ok ? { ok: true, value: result.value.applications } : result;
}

/** Revoke one. Its next call is refused. */
export function revokeConnectedApplication(
  clientId: string,
  options?: AuthClientOptions,
): Promise<AuthResult<{ revoked: true }>> {
  return callAuth(`/connections/${encodeURIComponent(clientId)}`, { method: "DELETE" }, mcpOptions(options), isRevoked);
}
