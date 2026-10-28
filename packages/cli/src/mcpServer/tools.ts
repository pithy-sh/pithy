// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute, ControlPlaneManifest } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { controlPlaneToolName } from "@pithy-sh/core/src/controlPlane/discovery/toolName";
import { MOST_RESTRICTIVE_SCOPE_KIND, type ScopeKind, scopeKindOf } from "@pithy-sh/core/src/controlPlane/scope/kind";
import { MANIFEST_READ_SCOPE } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { KIND_SENTENCES, kindAnnotations, type ToolAnnotations } from "@pithy-sh/core/src/mcp/annotations";
import type { CallArguments, CallableRoute } from "./caller";

/**
 * The tools one connection offers, derived from its Worker's live manifest (`docs/AGENT-ACCESS.md` §3, §5).
 *
 * **Offered only when it can be called.** The server asks the three questions a dashboard pane asks — does this
 * Worker compose the capability, does it declare this route, and was this connection granted its scope — and a
 * tool failing any of them is not offered, rather than offered and refused. The manifest answers all three in one
 * read: it lists only what is composed, each route as declared, and `grantedScopes` beside them. So learning that a
 * tool is withheld costs no call to that tool's route and mints no credential for its scope.
 *
 * **A route without `operation` and `input` is not offered.** Both are optional on the wire, and a Worker that
 * predates them sends neither; guessing a name from the path would break §5's permanence the day the adopter moves
 * a `basePath`, and a tool with no schema is one an agent has to guess the arguments of.
 *
 * **A route with no scope** needs only a verified caller. It is offered when it takes no input — `ping` — and not
 * otherwise, because a scopeless route that takes input is one whose body decides the scope (the presence ticket
 * route), which a tool cannot know ahead of the call. It signs as the manifest read. A scopeless `GET` is a read;
 * any other method declares no kind and may change anything, so it is treated as the most restrictive.
 *
 * **A tool says what kind of thing it does.** Its route's scope kind sets its MCP annotations and leads its
 * description, so a client that ignores annotations still shows a charge as a charge. A scoped route from a Worker
 * too old to state a kind is treated as the most restrictive.
 */

/** One tool, and the route it calls. */
export interface ControlPlaneTool {
  /** `<capability>_<operation>`, normalized in `controlPlaneToolName`. */
  readonly name: string;
  /** The tool's kind in plain words, then the route's own summary in its capability's words. */
  readonly description: string;
  /** What kind of thing a call does: its route's scope kind. */
  readonly kind: ScopeKind;
  /** The MCP annotations its kind sets. */
  readonly annotations: ToolAnnotations;
  /** The route's input, as the manifest published it. */
  readonly inputSchema: Record<string, unknown>;
  /** The call to make. */
  readonly route: CallableRoute;
}

/** True when a route's input declares nothing to send. */
function takesNothing(input: Record<string, unknown>): boolean {
  const properties = input.properties;
  return typeof properties !== "object" || properties === null || Object.keys(properties).length === 0;
}

/** The scope a call to this route names and the kind it grants, or `null` when it is not one a tool may call. */
function callScope(route: AdminRoute, granted: ReadonlySet<string>): { scope: string; kind: ScopeKind } | null {
  if (route.scope === null) {
    // Any verified caller may call it, so the token names the scope the manifest itself was read under.
    if (route.input === undefined || !takesNothing(route.input)) return null;
    return { scope: MANIFEST_READ_SCOPE, kind: route.method === "GET" ? "reads" : MOST_RESTRICTIVE_SCOPE_KIND };
  }
  const kind = scopeKindOf(route);
  return granted.has(route.scope) && kind !== null ? { scope: route.scope, kind } : null;
}

/** Every tool this manifest offers this connection, in manifest order. */
export function offeredTools(manifest: ControlPlaneManifest): ControlPlaneTool[] {
  const granted = new Set(manifest.grantedScopes);
  const tools: ControlPlaneTool[] = [];
  for (const capability of manifest.capabilities) {
    for (const route of capability.adminRoutes) {
      if (route.operation === undefined || route.input === undefined) continue;
      const call = callScope(route, granted);
      if (call === null) continue;
      tools.push({
        name: controlPlaneToolName(capability.name, route.operation),
        description: `${KIND_SENTENCES[call.kind]} ${route.summary}`,
        kind: call.kind,
        annotations: kindAnnotations(call.kind),
        inputSchema: route.input,
        route: { method: route.method, path: route.path, scope: call.scope },
      });
    }
  }
  return tools;
}

/** A tool call's arguments as the route takes them: the object the input schema described, split by part. */
export function callArguments(args: Record<string, unknown> | undefined): CallArguments {
  const record = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const path = record(args?.path);
  const query = record(args?.query);
  return {
    ...(path === undefined ? {} : { path }),
    ...(query === undefined ? {} : { query }),
    ...(args?.body === undefined ? {} : { body: args.body }),
  };
}
