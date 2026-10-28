// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ClientDiscovery } from "@better-auth/oauth-provider";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { Context } from "hono";
import type { AuthInstance } from "../instance/auth";

/**
 * What the auth capability lends the MCP capability composed beside it.
 *
 * The authorization server lives inside the auth instance — Better Auth composes a provider as a plugin, so the
 * instance that signs a user in is the one that issues their agent's token. The MCP capability's routes need that
 * instance, the address it resolves for this request, and the database it reads, and nothing else; this is that,
 * and it is the only thing the MCP capability reads off auth.
 */
export interface McpHost {
  /** This request's auth instance — the one the session middleware already built, memoized per request. */
  instance(c: Context<PithyHonoEnv>): Promise<AuthInstance>;
  /** The origin this request's instance runs under: the config's `baseURL`, or in `dev` the request's own host. */
  baseURL(request: Request): string;
  /** Where the auth handler mounts, e.g. `/auth`. The issuer is `baseURL` + this. */
  readonly basePath: string;
  /** The D1 binding auth's tables live in. */
  readonly database: string;
}

/** What the MCP capability tells auth when composed, so the instance carries the provider. */
export interface McpWiring {
  /** Where the MCP endpoint mounts, e.g. `/mcp`. The resource is `baseURL` + this. */
  readonly path: string;
  /** The scaffolded consent screen's path. */
  readonly consentPage: string;
  /** How a client whose id is its metadata document's URL is resolved. One per composed `mcp()`, so its cache lasts. */
  readonly clientDiscovery: ClientDiscovery;
}
