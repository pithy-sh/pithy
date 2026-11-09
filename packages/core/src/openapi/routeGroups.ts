// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { RouteGroup } from "./document";

/**
 * Which capability registered which routes, recorded by `createBackend` as it mounts them.
 *
 * Every capability registers onto the one shared app with absolute paths, so the finished route table
 * says nothing about who owns a route. `createBackend` is the one place that knows — it calls each
 * `routes` hook in turn — so it notes the slice of `app.routes` each hook added, and the contract tags
 * each operation with the capability that owns it. Kept as a non-enumerable property of the app, so
 * the app a Worker exports enumerates as a plain Hono instance.
 */

/** The key an assembled app carries its route groups under. Global, so two copies of core agree. */
export const ROUTE_GROUPS = Symbol.for("pithy.routeGroups");

/** Route groups of an app that cannot take the property, such as a frozen one. Read by this copy alone. */
const UNMARKABLE = new WeakMap<object, readonly RouteGroup[]>();

/** Note the route groups of an assembled app. Called by `createBackend` and nothing else. */
export function recordRouteGroups(app: object, groups: readonly RouteGroup[]): void {
  const own = Object.getOwnPropertyDescriptor(app, ROUTE_GROUPS);
  if (own ? own.configurable : Object.isExtensible(app)) {
    Object.defineProperty(app, ROUTE_GROUPS, { value: groups, configurable: true });
  } else {
    UNMARKABLE.set(app, groups);
  }
}

/** The route groups `createBackend` recorded for this app, or `undefined` for an app it did not assemble. */
export function routeGroupsOf(app: object): readonly RouteGroup[] | undefined {
  const groups: unknown = UNMARKABLE.get(app) ?? Object.getOwnPropertyDescriptor(app, ROUTE_GROUPS)?.value;
  return Array.isArray(groups) ? groups : undefined;
}
