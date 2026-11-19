// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { RouteGroup, RouterRoute } from "./document";

/**
 * Which capability registered which routes, recorded by `createBackend` as it mounts them.
 *
 * Every capability registers onto the one shared app with absolute paths, so the finished route table
 * says nothing about who owns a route. `createBackend` is the one place that knows — it mounts each
 * capability in turn — so it notes each capability's routes, and the contract tags each operation with
 * the capability that owns it. Kept as a non-enumerable property of the app, so the app a Worker exports
 * enumerates as a plain Hono instance.
 *
 * A capability's routes are built on first use, so what is recorded at assembly is a way to reach them:
 * {@link routeGroupsOf} loads every capability's routes and resolves to the finished groups.
 */

/** One capability's routes as `createBackend` records them: those mounted at assembly, and a loader for the rest. */
export interface RecordedRouteGroup {
  /** The tag, normally the capability's name. */
  readonly tag: string;
  /** The routes mounted at assembly, in registration order. */
  readonly routes: readonly RouterRoute[];
  /** Loads the capability's routes and resolves to them. They come ahead of {@link routes}. */
  readonly loaded?: () => Promise<readonly RouterRoute[]>;
}

/** What an app carries: its recorded groups, and the resolution once one has been asked for. */
interface Recorded {
  readonly groups: readonly RecordedRouteGroup[];
  resolved?: Promise<readonly RouteGroup[]>;
}

/** The key an assembled app carries its route groups under. Global, so two copies of core agree. */
export const ROUTE_GROUPS = Symbol.for("pithy.routeGroups");

/** Route groups of an app that cannot take the property, such as a frozen one. Read by this copy alone. */
const UNMARKABLE = new WeakMap<object, Recorded>();

/** Note the route groups of an assembled app. Called by `createBackend` and nothing else. */
export function recordRouteGroups(app: object, groups: readonly RecordedRouteGroup[]): void {
  const recorded: Recorded = { groups };
  const own = Object.getOwnPropertyDescriptor(app, ROUTE_GROUPS);
  if (own ? own.configurable : Object.isExtensible(app)) {
    Object.defineProperty(app, ROUTE_GROUPS, { value: recorded, configurable: true });
  } else {
    UNMARKABLE.set(app, recorded);
  }
}

function recordedOf(app: object): Recorded | undefined {
  const recorded: unknown = UNMARKABLE.get(app) ?? Object.getOwnPropertyDescriptor(app, ROUTE_GROUPS)?.value;
  return typeof recorded === "object" && recorded !== null && "groups" in recorded ? (recorded as Recorded) : undefined;
}

async function resolve(groups: readonly RecordedRouteGroup[]): Promise<readonly RouteGroup[]> {
  const resolved = await Promise.all(
    groups.map(async (group) => ({
      tag: group.tag,
      routes: group.loaded ? [...(await group.loaded()), ...group.routes] : group.routes,
    })),
  );
  // Refused here because no route's declaration can be read before its capability loads: a tool on the wrong
  // method, or two routes sharing an operation, fails every reader of the route table (`mcp/tools.ts`).
  const { assertToolDeclarations } = await import("../mcp/tools");
  assertToolDeclarations(resolved);
  return resolved;
}

/**
 * The route groups `createBackend` recorded for this app, every capability's routes loaded, or `undefined`
 * for an app it did not assemble. Resolves to the same array every time once it has succeeded.
 */
export function routeGroupsOf(app: object): Promise<readonly RouteGroup[] | undefined> {
  const recorded = recordedOf(app);
  if (recorded === undefined) return Promise.resolve(undefined);
  recorded.resolved ??= resolve(recorded.groups).catch((err: unknown) => {
    recorded.resolved = undefined;
    throw err;
  });
  return recorded.resolved;
}
