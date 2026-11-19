// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DeclaredRoute } from "@pithy-sh/core/src/http/lazyRoutes";

/**
 * Every route `registerMcpRoutes` mounts: the protected-resource and authorization-server metadata, each at its
 * suffixed and bare well-known path, the endpoint at `path`, its consent screen and the caller's connections.
 */
export function mcpRouteTable(path: string, authBasePath: string): DeclaredRoute[] {
  return [
    { method: "GET", path: `/.well-known/oauth-protected-resource${path}` },
    { method: "GET", path: "/.well-known/oauth-protected-resource" },
    { method: "GET", path: `/.well-known/oauth-authorization-server${authBasePath}` },
    { method: "GET", path: "/.well-known/oauth-authorization-server" },
    { method: "POST", path },
    { method: "GET", path },
    { method: "DELETE", path },
    { method: "GET", path: `${path}/consent` },
    { method: "POST", path: `${path}/consent` },
    { method: "GET", path: `${path}/connections` },
    { method: "DELETE", path: `${path}/connections/:clientId` },
  ];
}
