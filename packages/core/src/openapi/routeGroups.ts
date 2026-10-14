// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { RouteGroup } from "./document";

/**
 * Which capability registered which routes, recorded by `createBackend` as it mounts them.
 *
 * Every capability registers onto the one shared app with absolute paths, so the finished route table
 * says nothing about who owns a route. `createBackend` is the one place that knows — it calls each
 * `routes` hook in turn — so it notes the slice of `app.routes` each hook added, and the contract tags
 * each operation with the capability that owns it. Held beside the app rather than on it, so the app a
 * Worker exports is the plain Hono instance it always was.
 */
const recorded = new WeakMap<object, readonly RouteGroup[]>();

/** Note the route groups of an assembled app. Called by `createBackend` and nothing else. */
export function recordRouteGroups(app: object, groups: readonly RouteGroup[]): void {
  recorded.set(app, groups);
}

/** The route groups `createBackend` recorded for this app, or `undefined` for an app it did not assemble. */
export function routeGroupsOf(app: object): readonly RouteGroup[] | undefined {
  return recorded.get(app);
}
