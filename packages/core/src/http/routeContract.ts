import type { Context, Hono, Next } from "hono";

/**
 * Gate 2 of the route request contract (issue #74). Its sibling, the `no-raw-request-input` Biome
 * plugin, covers query and body: with `c.req.query()` and `c.req.json()` unavailable, the only way
 * to read either is `c.req.valid()`, which only exists once a validator declared it. Path params
 * have no such chokepoint — a handler can always reach one through a validator it never declared —
 * so they need a positive check instead of a ban, and this is it.
 *
 * A composed app is the only place the answer lives: `Capability.routes` registers onto the app it
 * is handed, so nothing static can see the finished route table. `app.routes` can — it carries one
 * entry per registered handler, in order, with the path pattern intact.
 *
 * Identifying a param validator is the awkward part. `@hono/zod-validator` returns the same
 * anonymous closure whatever its target, so there is nothing to inspect: no name, no property, no
 * distinguishing shape. What does differ is *behaviour* — `hono/validator` reads `c.req.param()`
 * for the `param` target and nothing else does. So each middleware is invoked once against a probe
 * context that records which accessor it touched. It is a real call, which is why only middleware
 * are probed (never the terminal handler) and why every throw is swallowed: a guard meeting an
 * empty context is expected to reject, and a validator meeting empty params is expected to fail
 * validation. Either way the flag has already been set or not.
 */

/** One route that reads path params without declaring a schema for them. */
export interface UncoveredRoute {
  /** HTTP method as Hono records it (`GET`, `POST`, `ALL`, …). */
  method: string;
  /** The registered path pattern, e.g. `/leaderboard/:board/entries/:userId`. */
  path: string;
  /** The `:segment` names the path declares. */
  params: string[];
}

/** The `:segment` names in a path pattern, in order. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1] as string);
}

/**
 * A context that answers every accessor `hono/validator` reaches for, and records the one that
 * identifies a `param` validator. Deliberately minimal: anything a real guard reads is absent, so
 * a guard rejects immediately instead of doing work.
 */
function probeContext(record: () => void) {
  const req = {
    param: () => {
      record();
      return {};
    },
    queries: () => ({}),
    query: () => ({}),
    header: (name?: string) => (name === undefined ? {} : undefined),
    json: async () => ({}),
    parseBody: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
    valid: () => ({}),
    addValidatedData: () => {},
    bodyCache: {},
    url: "http://route-contract.probe/",
    raw: new Request("http://route-contract.probe/"),
  };
  return { req, env: {}, var: {}, get: () => undefined, set: () => {} } as unknown as Context;
}

/** Does this middleware read `c.req.param()` — i.e. is it a `zValidator("param", …)`? */
async function readsPathParams(handler: (c: Context, next: Next) => unknown): Promise<boolean> {
  let read = false;
  try {
    await handler(
      probeContext(() => {
        read = true;
      }),
      (async () => {}) as Next,
    );
  } catch {
    // Expected: a guard rejects an empty context, a validator rejects empty params. Both are fine —
    // whether `c.req.param()` was reached has already been decided by the time anything throws.
  }
  return read;
}

/**
 * Every route on this app that declares a `:segment` but registers no param validator for it.
 * An empty array is the contract being met. Feed it a composed app — one that every capability's
 * `routes` has already been applied to.
 */
export async function uncoveredParamRoutes(app: Hono<never>): Promise<UncoveredRoute[]> {
  const grouped = new Map<string, { method: string; path: string; handlers: ((c: Context, n: Next) => unknown)[] }>();
  for (const route of app.routes) {
    const key = `${route.method} ${route.path}`;
    const entry = grouped.get(key) ?? { method: route.method, path: route.path, handlers: [] };
    entry.handlers.push(route.handler as (c: Context, n: Next) => unknown);
    grouped.set(key, entry);
  }

  const uncovered: UncoveredRoute[] = [];
  for (const { method, path, handlers } of grouped.values()) {
    const params = pathParams(path);
    if (params.length === 0) continue;
    // The last entry is the route's own handler; probing it would run real business logic.
    const middleware = handlers.slice(0, -1);
    let covered = false;
    for (const handler of middleware) {
      if (await readsPathParams(handler)) {
        covered = true;
        break;
      }
    }
    if (!covered) uncovered.push({ method, path, params });
  }
  return uncovered;
}
