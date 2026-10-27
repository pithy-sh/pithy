// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type RouteSpec, routeSpecOf } from "../http/routeSpec";
import type { RouteGroup, RouterRoute } from "./document";

/**
 * The composed route table as operations: one per method and path, with the spec its `describeRoute` declared.
 *
 * Hono keeps one entry per handler, so a route with a `describeRoute` ahead of its handler appears twice in
 * `app.routes`. Two readers need the grouped view: the OpenAPI document, which turns each operation into a path
 * item, and the evidence pack (#821), which counts how every route verifies its caller. They group the same way
 * because they group here, and the pack never loads the JSON Schema conversion the document needs.
 */

/** One route's handlers, grouped by method and path the way Hono stores them: one entry per handler. */
export interface Operation {
  readonly method: string;
  readonly path: string;
  readonly handlers: unknown[];
}

/** Group a route table into operations, in registration order. */
export function operationsOf(routes: readonly RouterRoute[]): Operation[] {
  const byKey = new Map<string, Operation>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const entry = byKey.get(key) ?? { method: route.method, path: route.path, handlers: [] };
    entry.handlers.push(route.handler);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

/**
 * An `ALL` entry with no spec is `app.use` — middleware, not a route — because Hono records both as
 * `ALL`. An `app.all` route that forgot its `describeRoute` is therefore invisible to the coverage
 * check, which is the one blind spot here; the kit has one such route and it is described.
 */
export function isMiddlewareOnly(operation: Operation): boolean {
  return operation.method === "ALL" && !operation.handlers.some((handler) => routeSpecOf(handler));
}

/** One route, and the spec it declared — `undefined` for a route that registered no `describeRoute`. */
export interface DescribedOperation {
  readonly method: string;
  readonly path: string;
  readonly spec: RouteSpec | undefined;
}

/** Every route in these groups, middleware left out, each with the spec it declared or `undefined`. */
export function describedOperations(groups: readonly RouteGroup[]): DescribedOperation[] {
  return groups.flatMap((group) =>
    operationsOf(group.routes)
      .filter((operation) => !isMiddlewareOnly(operation))
      .map((operation) => ({
        method: operation.method,
        path: operation.path,
        spec: operation.handlers.map(routeSpecOf).find((candidate) => candidate !== undefined),
      })),
  );
}
