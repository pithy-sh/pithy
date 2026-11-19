// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Context, Hono, type Next } from "hono";
import type { PithyHonoEnv } from "../capability/capability";
import { routeSpecOf } from "./routeSpec";

/**
 * **A capability's routes, built on the first request that reaches one of them.**
 *
 * A capability hands core the methods and paths it serves and a loader for the module that mounts them.
 * Core registers the declared table on the Worker's app at assembly, so the router matches in the order an
 * eager mount gives, and imports and mounts the module on the first request a declared route matches. The
 * module's Hono app, its schemas and everything it imports are evaluated then, not at Worker startup,
 * which is what keeps startup inside Cloudflare's CPU limit.
 *
 * A request reaches the loaded routes behind every middleware the Worker registered before them: CORS, the
 * base context, each capability's middleware and the readiness guards. It enters the group's own app with
 * the Worker's context variables, headers and cached body, and leaves it with whatever variables the group
 * set. An error inside the group is rethrown, so the Worker's error handler answers it.
 */

/** A method a declared route answers. `ALL` is a route mounted with `app.all`. */
export type RouteMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "ALL";

/** One method and path pattern, exactly as the loaded module mounts it. */
export interface DeclaredRoute {
  readonly method: RouteMethod;
  readonly path: string;
}

/** What core hands a capability's mount beside the app it mounts on. */
export interface RouteHost {
  /**
   * The Worker's composed app. A capability that dispatches into the Worker's own routes, such as the MCP
   * endpoint calling a tool, or reads the composed route table, reaches it here. The app a mount is handed
   * holds that capability's routes alone.
   */
  readonly composed: Hono<PithyHonoEnv>;
}

/** Mounts a capability's routes. Called once, when the module that holds it has loaded. */
export type RouteMount = (app: Hono<PithyHonoEnv>, host: RouteHost) => void;

/** A capability's routes: the table core registers at startup, and the loader it calls on first use. */
export interface CapabilityRoutes {
  /**
   * Every method and path the loaded mount registers. An `app.use` is declared as an `ALL` route at its path,
   * unless a declared `ALL` route already covers it, so every request it runs for enters the loaded routes.
   */
  readonly declared: readonly DeclaredRoute[];
  /** Imports the module that mounts the routes, `() => import("./http/routes")`, and returns its mount. */
  readonly load: () => Promise<RouteMount>;
}

/** Declare routes under one base path: `declareRoutes("/ledger", [["GET", "/:currency"]])`. */
export function declareRoutes(base: string, routes: readonly (readonly [RouteMethod, string])[]): DeclaredRoute[] {
  return routes.map(([method, path]) => ({ method, path: `${base}${path}` }));
}

/** One entry of a Hono app's route table. */
type RouterRoute = Hono["routes"][number];

/** One request's crossing into a group's own app, keyed by the request both contexts share. */
interface Crossing {
  readonly outer: Context<PithyHonoEnv>;
  inner?: Context<PithyHonoEnv>;
  unmatched: boolean;
}

const crossings = new WeakMap<Request, Crossing>();

type VarSetter = (key: string, value: unknown) => void;

function copyVars(from: Context<PithyHonoEnv>, to: Context<PithyHonoEnv>): void {
  const set = to.set as unknown as VarSetter;
  const current: Readonly<Record<string, unknown>> = to.var;
  for (const [key, value] of Object.entries(from.var)) {
    if (current[key] !== value) set(key, value);
  }
}

function executionOf(c: Context<PithyHonoEnv>): Context["executionCtx"] | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * The headers the Worker's middleware set before the group runs, moved onto the group's context.
 *
 * Hono holds a header set ahead of the response in the context that set it, and applies it only to a
 * response that context creates. The group's response is created by its own context, so each header goes
 * across first, in order, and the response carries it exactly as an eagerly mounted route's would.
 */
function carryHeaders(from: Context<PithyHonoEnv>, to: Context<PithyHonoEnv>): void {
  const headers = from.res.headers;
  for (const cookie of headers.getSetCookie()) to.header("set-cookie", cookie, { append: true });
  for (const [name, value] of headers.entries()) {
    if (name !== "set-cookie") to.header(name, value, { append: true });
  }
  // The response the read above created is dropped, so the group's response becomes the Worker's as it
  // is rather than being merged into an empty one. The headers stay prepared on the Worker's context, for
  // a response it creates itself when the group answers nothing. Dropping the response marks the context
  // finalized, which would stop Hono taking the group's response, so that is undone with it.
  from.res = undefined;
  from.finalized = false;
}

/**
 * The headers the group set ahead of a response it never made, moved back onto the Worker's context: an error
 * the Worker's handler answers, or a request the group did not match. The group's headers began as the
 * Worker's, so each one replaces the Worker's own, and only the cookies the group added are added.
 */
function returnHeaders(from: Context<PithyHonoEnv>, to: Context<PithyHonoEnv>): void {
  const headers = from.res.headers;
  const had = to.res.headers.getSetCookie().length;
  to.res = undefined;
  to.finalized = false;
  for (const [name, value] of headers.entries()) {
    if (name !== "set-cookie") to.header(name, value);
  }
  for (const cookie of headers.getSetCookie().slice(had)) to.header("set-cookie", cookie, { append: true });
}

/** The route table that marks where the group's own routes start: its crossing middleware is first. */
const CROSSING_ROUTES = 1;

/** The group's own app, with the crossing middleware first and the loaded mount after it. */
function groupApp(mount: RouteMount, host: RouteHost): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.use("*", async (c, next) => {
    const crossing = crossings.get(c.req.raw);
    if (crossing !== undefined) {
      copyVars(crossing.outer, c);
      carryHeaders(crossing.outer, c);
      Object.assign(c.req.bodyCache, crossing.outer.req.bodyCache);
      crossing.inner = c;
      // A variable the group sets is set on the Worker's context as it is set, so a closure the Worker's
      // middleware made over its own context, such as a resolver reading `c.var.auth`, reads it too.
      const set = c.set as unknown as VarSetter;
      const outerSet = crossing.outer.set as unknown as VarSetter;
      (c as unknown as { set: VarSetter }).set = (key, value) => {
        set(key, value);
        outerSet(key, value);
      };
    }
    await next();
  });
  mount(app, host);
  app.notFound((c) => {
    const crossing = crossings.get(c.req.raw);
    if (crossing !== undefined) {
      crossing.unmatched = true;
      returnHeaders(c, crossing.outer);
    }
    return c.body(null, 404);
  });
  app.onError((err, c) => {
    const crossing = crossings.get(c.req.raw);
    if (crossing !== undefined) {
      copyVars(c, crossing.outer);
      returnHeaders(c, crossing.outer);
    }
    throw err;
  });
  return app;
}

/** A capability's routes as mounted on the Worker's app: the routes the loaded module registered, on demand. */
export interface LazyMount {
  /** Loads the module if no request has yet, and resolves to the routes its mount registered. */
  routes(): Promise<readonly RouterRoute[]>;
}

/**
 * Register a capability's declared routes on `app`, loading the module behind them on first use.
 *
 * The module loads once, however many requests arrive while it is loading. A load that fails is tried
 * again on the next request. A request the loaded routes do not answer goes on to the next handler on
 * `app`, so a declared route the module does not mount answers as an undeclared one would.
 */
export function mountLazy(app: Hono<PithyHonoEnv>, routes: CapabilityRoutes, host: RouteHost): LazyMount {
  let loading: Promise<Hono<PithyHonoEnv>> | undefined;
  const loaded = (): Promise<Hono<PithyHonoEnv>> => {
    loading ??= routes.load().then(
      (mount) => groupApp(mount, host),
      (err: unknown) => {
        loading = undefined;
        throw err;
      },
    );
    return loading;
  };
  const dispatched = new WeakSet<Request>();

  const handler = async (c: Context<PithyHonoEnv>, next: Next): Promise<Response | undefined> => {
    if (dispatched.has(c.req.raw)) {
      await next();
      return undefined;
    }
    dispatched.add(c.req.raw);
    const group = await loaded();
    const crossing: Crossing = { outer: c, unmatched: false };
    crossings.set(c.req.raw, crossing);
    try {
      const res = await group.fetch(c.req.raw, c.env, executionOf(c));
      if (crossing.inner !== undefined) copyVars(crossing.inner, c);
      if (crossing.unmatched) {
        await next();
        return undefined;
      }
      return res;
    } finally {
      crossings.delete(c.req.raw);
    }
  };

  for (const route of routes.declared) app.on(route.method, route.path, handler);
  return { routes: async () => (await loaded()).routes.slice(CROSSING_ROUTES) };
}

/** Whether a route-table entry is `app.use` middleware: Hono records it as `ALL` with no `describeRoute`. */
function isMiddleware(route: RouterRoute): boolean {
  return route.method === "ALL" && routeSpecOf(route.handler) === undefined;
}

const keyOf = (route: DeclaredRoute): string => `${route.method} ${route.path}`;

/**
 * The method and path of every entry in a table, each once, in registration order. `app.use` middleware is
 * declared as an `ALL` route at its path, since a request reaches it only by entering the capability's routes.
 */
export function declaredRoutesOf(table: readonly RouterRoute[]): DeclaredRoute[] {
  const seen = new Set<string>();
  const declared: DeclaredRoute[] = [];
  for (const route of table) {
    const entry = { method: route.method as RouteMethod, path: route.path };
    if (seen.has(keyOf(entry))) continue;
    seen.add(keyOf(entry));
    declared.push(entry);
  }
  return declared;
}

/** Whether every request `path` matches also matches a declared `ALL` route: the same path, or under its `/*`. */
function coveredByAll(path: string, declared: readonly DeclaredRoute[]): boolean {
  return declared.some(
    (route) =>
      route.method === "ALL" &&
      (route.path === path ||
        route.path === "*" ||
        (route.path.endsWith("/*") && path.startsWith(route.path.slice(0, -1)))),
  );
}

/** How a capability's declared table and the routes its module mounts differ. Both empty when they agree. */
export interface RouteDrift {
  /**
   * Routes the module mounts that the table does not declare: no request can reach them. An `app.use` counts
   * unless a declared `ALL` route covers its path, since otherwise a request it should run for never enters
   * the capability's routes and the middleware silently does not run.
   */
  readonly undeclared: readonly DeclaredRoute[];
  /** Routes the table declares that the module does not mount. */
  readonly unmounted: readonly DeclaredRoute[];
}

/**
 * Load a capability's routes and compare what its module mounts against what it declares. A capability's
 * own test holds both lists empty, for every configuration that changes which routes it mounts.
 */
export async function routeDrift(routes: CapabilityRoutes): Promise<RouteDrift> {
  const scratch = new Hono<PithyHonoEnv>();
  (await routes.load())(scratch, { composed: scratch });
  const declaredKeys = new Set(routes.declared.map(keyOf));
  const middleware = new Set(scratch.routes.filter(isMiddleware).map((route) => keyOf(route as DeclaredRoute)));
  const routed = new Set(
    scratch.routes.filter((route) => !isMiddleware(route)).map((route) => keyOf(route as DeclaredRoute)),
  );
  const mounted = declaredRoutesOf(scratch.routes);
  const mountedKeys = new Set(mounted.map(keyOf));
  return {
    undeclared: mounted.filter((route) => {
      if (declaredKeys.has(keyOf(route))) return false;
      // An `ALL` key both a route and a middleware share is the route's; a middleware-only one may be covered.
      const middlewareOnly = middleware.has(keyOf(route)) && !routed.has(keyOf(route));
      return !(middlewareOnly && coveredByAll(route.path, routes.declared));
    }),
    unmounted: routes.declared.filter((route) => !mountedKeys.has(keyOf(route))),
  };
}

/** The declared routes of a capability's admin surface, read off the declarations it already makes for the manifest. */
export function adminRouteTable(
  declarations: readonly { readonly method: string; readonly path: string }[],
): DeclaredRoute[] {
  return declarations.map(({ method, path }) => ({ method: method as RouteMethod, path }));
}

/**
 * Routes whose mount is already in memory, with the declared table read off the mount itself. The table is read
 * each time core assembles a Worker, by running the mount against a scratch app, so a mount that reads the
 * composition's environment declares what that composition mounts. Nothing is deferred, so it saves no startup.
 * For a test's capability, and for a capability small enough that its startup does not matter.
 */
export function routesOf(mount: RouteMount): CapabilityRoutes {
  return {
    get declared() {
      const scratch = new Hono<PithyHonoEnv>();
      mount(scratch, { composed: scratch });
      return declaredRoutesOf(scratch.routes);
    },
    load: async () => mount,
  };
}

/**
 * Load a capability's routes now and mount them straight onto `app`, with none of the deferral `createBackend`
 * gives them. For a test, or a tool, that wants one capability's route table in hand.
 */
export async function mountRoutes(
  routes: CapabilityRoutes | undefined,
  app: Hono<PithyHonoEnv>,
  host: RouteHost = { composed: app },
): Promise<void> {
  if (routes === undefined) return;
  (await routes.load())(app, host);
}
