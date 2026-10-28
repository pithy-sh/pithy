// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { AuthContext } from "@pithy-sh/core/src/http/authContext";
import type { AppTool } from "@pithy-sh/core/src/mcp/tools";

/**
 * A tool call, made as the user it acts for (`docs/AGENT-ACCESS.md` §4.1).
 *
 * **A call is a request to the route, through the whole app, and nothing else.** The MCP endpoint builds the
 * request the route would have received from the user's own client — its method, its path with the parameters
 * filled in, its query and its JSON body — and hands it to the composed app. Every middleware runs, every guard
 * runs, the route's `describeRoute({ power })` gate runs, and the route's own in-handler checks run. So the tool
 * does exactly what the route allows this user, and **nothing consults the token for permission**: the endpoint
 * verified who the caller is, and the role decides what they may do. There is no second gate to keep in step.
 *
 * **Who it is, carried in process.** The request carries no credential. The verified identity rides beside it in
 * a `WeakMap` keyed by the request object itself, which nothing outside this isolate can reach or forge — a header
 * would be a credential a client could send. The session middleware reads it ({@link dispatchedAuth}) and publishes
 * it as `c.var.auth`, exactly as it would a session it resolved.
 */

const dispatched = new WeakMap<Request, AuthContext>();

/** The identity a dispatched request runs as, or `undefined` for every request that arrived over the network. */
export function dispatchedAuth(request: Request): AuthContext | undefined {
  return dispatched.get(request);
}

/** A call's arguments, as the tool's input schema shaped them: `{ path, query, body }`. */
export interface ToolArguments {
  readonly path?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Split a call's arguments back out along the three keys the input schema joined them under. */
export function toolArguments(args: Record<string, unknown>): ToolArguments {
  const path = record(args.path);
  const query = record(args.query);
  return {
    ...(path === undefined ? {} : { path }),
    ...(query === undefined ? {} : { query }),
    ...(args.body === undefined ? {} : { body: args.body }),
  };
}

function missing(name: string, tool: AppTool): never {
  throw new ValidationError({
    message: `The tool ${tool.name} needs path.${name}.`,
    detail: `tool ${tool.name} (${tool.method} ${tool.path}) was called without path parameter ${name}`,
  });
}

function elsewhere(tool: AppTool, detail: string): never {
  throw new ValidationError({
    message: `The tool ${tool.name} cannot be called with that path.`,
    detail: `tool ${tool.name} (${tool.method} ${tool.path}): ${detail}`,
  });
}

/** `.` and `..` survive `encodeURIComponent`, and the URL parser collapses them into a different route. */
function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

/** One path segment, encoded so it stays one segment, and refused when it is empty or a dot segment. */
function segment(name: string, value: string, tool: AppTool): string {
  if (value.length === 0) return missing(name, tool);
  if (isDotSegment(value)) return elsewhere(tool, `path.${name} is the dot segment "${value}"`);
  return encodeURIComponent(value);
}

/**
 * The URL path and query a call reaches: Hono's `:name` and `:name{pattern}` filled from `path`, each segment
 * encoded so a value cannot add a segment of its own, and `query` as a search string. A value that is a dot
 * segment is refused, since it would climb out of the tool's route into one that never declared itself a tool.
 */
export function toolUrl(tool: AppTool, args: ToolArguments): string {
  const path = tool.path
    .replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g, (_match, name: string) => {
      const value = args.path?.[name];
      if (value === undefined || value === null) return missing(name, tool);
      return segment(name, String(value), tool);
    })
    .replace(/\*$/, () => {
      const value = args.path?.path;
      if (value === undefined) return missing("path", tool);
      const segments = String(value).split("/");
      if (segments.some(isDotSegment)) return elsewhere(tool, "path.path holds a dot segment");
      return segments.map(encodeURIComponent).join("/");
    });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, String(item));
  }
  const query = search.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

/**
 * The request a call makes to its route, registered to run as `auth`. Refused when the URL parser would read the
 * built path as any other path: whatever the reason, the request would then reach a route the tool is not.
 */
export function dispatchRequest(origin: string, tool: AppTool, args: ToolArguments, auth: AuthContext): Request {
  const hasBody = args.body !== undefined && tool.method !== "GET" && tool.method !== "HEAD";
  const built = toolUrl(tool, args);
  const url = new URL(built, origin);
  const builtPath = built.split("?")[0] ?? built;
  if (url.pathname !== builtPath) elsewhere(tool, `${builtPath} resolves to ${url.pathname}`);
  const request = new Request(url, {
    method: tool.method,
    headers: { accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(args.body) } : {}),
  });
  dispatched.set(request, auth);
  return request;
}

/** A route's answer, as a tool call reports it: the status, and the body parsed when it is JSON. */
export async function dispatchedOutcome(response: Response): Promise<{ status: number; body: unknown }> {
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("json")) {
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: text };
    }
  }
  return { status: response.status, body: text };
}
