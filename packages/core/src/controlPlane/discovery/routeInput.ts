// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { requestContractOf } from "../../http/validation";
import { jsonSchema, type RouteGroup } from "../../openapi/document";
import { operationsOf } from "../../openapi/operations";
import type { AdminRoute, AdminRouteInput, CapabilityDeclaration } from "./adminRoute";

/**
 * What each admin route takes, read off the composed router (#723, `docs/AGENT-ACCESS.md` §3).
 *
 * **Generated, never declared.** A route already states what it accepts on its own line — `validate("param",
 * …)`, `validate("query", …)`, `validate("json", …)` — and that is the schema the request is actually parsed
 * with. So the manifest's `input` is that schema, converted once, rather than a second description a capability
 * would have to keep in step with the first. A route that changes its body changes its tool on the same commit.
 *
 * **One object, three parts.** An MCP tool takes one argument object, and a route reads three places, so the
 * input is an object with a `path`, a `query` and a `body` property — each present only when the route
 * validates that part. A client splits the arguments back out along the same three keys. A route that
 * validates nothing still gets an input: an empty object, which says *this takes nothing* rather than *this
 * Worker cannot say*.
 */

/** The three parts of a request an admin route's input may carry, and the validator target each comes from. */
const PARTS = { param: "path", query: "query", json: "body" } as const;

/**
 * The JSON Schema of one route's input, built from the request contracts on its handlers. The app's own MCP tools
 * (`../../mcp/tools.ts`) take their input from here too, so a tool on either server has one shape.
 */
export function inputOf(handlers: readonly unknown[]): AdminRouteInput {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const handler of handlers) {
    const contract = requestContractOf(handler);
    if (contract === undefined) continue;
    const part = PARTS[contract.target as keyof typeof PARTS];
    if (part === undefined) continue;
    properties[part] = jsonSchema(contract.schema, "input");
    // A path parameter is always present. A query arrives as an object even when the URL carries none, so it is
    // required only when its schema refuses an empty one; a body is required when its schema refuses none at all.
    const absent = part === "query" ? {} : undefined;
    if (part === "path" || !contract.schema.safeParse(absent).success) required.push(part);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * Every routed operation's input, keyed `METHOD path` as the manifest's admin routes are. Routes the groups do
 * not hold are simply absent — an admin route the router does not serve is `missingAdminRoutes`'s finding, not
 * this module's.
 */
export function routeInputs(groups: readonly RouteGroup[]): ReadonlyMap<string, AdminRouteInput> {
  const inputs = new Map<string, AdminRouteInput>();
  for (const group of groups) {
    for (const operation of operationsOf(group.routes)) {
      inputs.set(`${operation.method.toUpperCase()} ${operation.path}`, inputOf(operation.handlers));
    }
  }
  return inputs;
}

/**
 * The declarations with each admin route's `input` filled in from the router.
 *
 * Without route groups — an app `createBackend` did not assemble — the declarations go out as they are, and a
 * client offers no tool for a route it was told nothing about. That is the same answer an older Worker gets.
 */
export function withRouteInputs(
  declarations: readonly CapabilityDeclaration[],
  inputs: ReadonlyMap<string, AdminRouteInput> | undefined,
): CapabilityDeclaration[] {
  if (inputs === undefined) return [...declarations];
  return declarations.map((declaration) => ({
    ...declaration,
    adminRoutes: declaration.adminRoutes.map((route): AdminRoute => {
      const input = inputs.get(`${route.method} ${route.path}`);
      return input === undefined ? route : { ...route, input };
    }),
  }));
}
