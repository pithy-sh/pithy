// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Hono, MiddlewareHandler } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { LOCAL_ENVIRONMENT } from "../../naming/environment";
import { ENVIRONMENT_VAR } from "../../worker/identity";
import type { AdminRoute } from "../discovery/adminRoute";
import { CONTROL_PLANE_HEADER, CONTROL_PLANE_VERSION_CREATED_HEADER, CONTROL_PLANE_VERSION_HEADER } from "../wire";

/**
 * CORS for the control-plane surface — the one thing standing between a browser and a Worker that is
 * up, healthy, and answering.
 *
 * **Why this exists at all.** A control-plane call carries its token on {@link CONTROL_PLANE_HEADER},
 * which is not a CORS-safelisted request header, so a browser sends `OPTIONS` first and refuses to send
 * the real request until something answers it. Nothing did. The failure surfaced as a `TypeError` from
 * `fetch` naming the host, so a reachable Worker read as an unreachable one — and the browser-direct
 * path is the whole reason the seam is shaped this way, since the alternative is proxying an adopter's
 * data through a management client's origin.
 *
 * **The allow-list is static config and never a connection row.** A preflight is the one request on
 * this surface that is answered before any credential is read: there is nothing to authenticate it
 * with, because the browser sends it before it will send the token. Consulting D1 would therefore turn
 * it into an oracle over which origins are registered, answerable by anyone. So the list is
 * `[issuer, ...allowedOrigins]` off the parsed config, computed once at composition, and this module
 * reads no database.
 *
 * **An unlisted origin is refused by omission.** It gets the same `204` and the same empty body as an
 * allowed one, with no `Access-Control-Allow-Origin` — the browser blocks the read, and the response
 * says nothing about what the list contains. A `403` here would be more honest as an API and would also
 * be the oracle above, so it is deliberately not one; the caller already sees a clear console error.
 *
 * **No `hono/cors`.** `worker-safety.test.ts` freezes the import allowlist and the middleware is not on
 * it (`docs/STACK.md` notes the ReDoS advisory against it). It also cannot express either of the two
 * rules above — a refusal that is byte-identical to an acceptance, and credentials that are never
 * allowed — so hand-rolling costs about forty lines and buys the behavior the seam actually needs.
 */

/** The hostnames a browser reaches a developer's own machine at, and the only ones §dev will allow. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether this request may use the **local dev** allowance: a loopback origin, in the dev environment.
 *
 * A console an adopter runs against a local Worker sits on `http://localhost:<port>`, on a port the dev
 * port allocator picked. Nobody can write that into `allowedOrigins` and have it stay true across
 * checkouts, so in dev the seam simply allows this machine.
 *
 * **Two guards: `ENVIRONMENT` is `dev`, and the hostname is loopback.** Take the first for what it is
 * — a var the adopter stamps, and `pithy init` writes `dev` into the top-level `wrangler.jsonc` stanza
 * (`cli/src/project/workerScaffold.ts`) that a bare `pithy deploy` publishes. So this is not a claim
 * that the allowance cannot appear on a deployed Worker.
 *
 * It is a claim about what the allowance is *worth*, and that holds wherever it appears. The origins it
 * admits name the caller's **own machine**. No ambient authority crosses, because
 * `Access-Control-Allow-Credentials` is never set on this surface and the token is an explicit header.
 * And every admin route still demands a verified control-plane token. So the most this permits is a
 * local page reading a reply it could have fetched directly, which is not a capability anyone gains.
 *
 * **Do not reach for `<STEM>_ORIGIN` here.** It looks like the precise version of this and it does not
 * work: `pithy dev` publishes those into each child *process*, and the host environment does not cross
 * into workerd — `cli/src/dev/env.ts:157-165`. Only capability *hosts* are forwarded as `--var`
 * (`hostVarArgs`), deliberately (#410), and a UI worker is not one. So a Worker's `env` never carries
 * the console's address, and a version of this that read one allowed exactly the origins no browser
 * calls while reading as though it did more.
 *
 * It is a per-request read rather than part of {@link allowedOriginSet} because in Workers there is no
 * `env` until a request arrives.
 */
export function devLoopbackAllows(env: Record<string, unknown>, origin: string): boolean {
  if (env[ENVIRONMENT_VAR] !== LOCAL_ENVIRONMENT) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** The two response headers a client must be allowed to read off an admin response, as one value. */
const EXPOSE_HEADERS = `${CONTROL_PLANE_VERSION_HEADER}, ${CONTROL_PLANE_VERSION_CREATED_HEADER}`;

/**
 * One origin, normalized the way a browser spells it, or `null` when the value is not one.
 *
 * Applied to both ends deliberately. `issuer` is a `z.url()` that predates this module and may legally
 * carry a path or a trailing slash, and an `Access-Control-Allow-Origin` carrying either matches no
 * browser `Origin` — so it is normalized rather than trusted. The incoming header is normalized for the
 * same reason from the other direction: it is not ours, and comparing raw strings would turn a spelling
 * difference into a refusal nobody can diagnose.
 */
export function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    // Opaque origins stringify as "null" — a data: or sandboxed frame. Never echo that back: it is a
    // literal match for the string a browser sends for an origin it deliberately refuses to name.
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * The effective allow-list: `[issuer, ...allowedOrigins]`, normalized, then deduped.
 *
 * Additive in that order and never replacing, which is the property the whole shape rests on: an
 * adopter who adds their own console cannot silently drop the dashboard that was already working, and
 * a replacing default would have done exactly that the first time someone wrote a single entry.
 * Dedupe happens **after** normalization, so `https://app.pithy.sh` and `https://app.pithy.sh/` are one
 * entry rather than two.
 */
export function allowedOriginSet(config: { issuer: string; allowedOrigins: readonly string[] }): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of [config.issuer, ...config.allowedOrigins]) {
    const origin = originOf(value);
    if (origin !== null) origins.add(origin);
  }
  return origins;
}

/** One path's precomputed answer. Built once at composition; nothing here is derived per request. */
export interface CorsSurfaceEntry {
  /** The fully mounted path, exactly as the descriptor declares it — `:segment` params included. */
  path: string;
  /** `Access-Control-Allow-Methods`: every method declared on this path, plus `OPTIONS`. */
  allowMethods: string;
  /** `Access-Control-Allow-Headers`: the token header, plus `content-type` where a body is plausible. */
  allowHeaders: string;
}

/**
 * Fold every composed capability's `adminRoutes` into one entry per distinct path.
 *
 * **The descriptors are the surface.** They already exist, a management client already navigates by
 * them, and `routeContract.test.ts` already proves they agree with the mounted router — so deriving
 * CORS from the same table means a capability that adds an admin route gets its preflight for free and
 * there is no second list to drift. The alternative considered and rejected was an app-wide
 * `app.use("*", …)`, which would attach dashboard origins to the adopter's own API — a different
 * surface, with different origins, that is not the kit's decision to make.
 *
 * **`content-type` keys on the method, not on whether the route takes a body.** {@link AdminRoute}
 * carries no body flag, and adding one is worse than the proxy it would replace: that type is read
 * across a version boundary by the management client, so a new field must be `.optional()` and an
 * absent optional says less than the method already does.
 */
export function corsSurface(capabilities: readonly { adminRoutes?: readonly AdminRoute[] }[]): CorsSurfaceEntry[] {
  const methodsByPath = new Map<string, Set<string>>();
  for (const capability of capabilities) {
    for (const route of capability.adminRoutes ?? []) {
      const methods = methodsByPath.get(route.path) ?? new Set<string>();
      methods.add(route.method);
      methodsByPath.set(route.path, methods);
    }
  }

  return [...methodsByPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, methods]) => {
      const carriesBody = [...methods].some((method) => method !== "GET");
      return {
        path,
        allowMethods: [...methods, "OPTIONS"].join(", "),
        allowHeaders: carriesBody ? `${CONTROL_PLANE_HEADER}, content-type` : CONTROL_PLANE_HEADER,
      };
    });
}

/**
 * The per-path middleware: answer the preflight, and mark the real response readable.
 *
 * Both halves are here rather than in an `app.options(…)` of their own, because a preflight that is
 * allowed and a response that cannot be read is the same failure as no preflight at all — the browser
 * blocks a `GET` whose response carries no `Access-Control-Allow-Origin`, `204` or not.
 */
export function corsMiddleware(
  entry: CorsSurfaceEntry,
  origins: ReadonlySet<string>,
  maxAgeSeconds: number,
): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    // On every response this layer touches, echoing or not. The allowed and the refused answer differ
    // by exactly one header, so a shared cache keyed on the URL alone would serve one origin's
    // `Access-Control-Allow-Origin` to another. Deliberately wider than "responses that echo an origin".
    c.header("Vary", "Origin", { append: true });

    const origin = originOf(c.req.raw.headers.get("origin"));
    const allowed =
      origin !== null && (origins.has(origin) || devLoopbackAllows(c.env as Record<string, unknown>, origin));
    if (allowed) c.header("Access-Control-Allow-Origin", origin);

    // Never `Access-Control-Allow-Credentials`. The token rides a header and this surface sets no
    // cookie, so the kit never opts into credentialed CORS — and the day someone wants cookies here,
    // that is a decision with a threat model, not a header to add.

    if (c.req.method === "OPTIONS") {
      // The preflight's own headers only where the origin is allowed: a refusal that names the methods
      // and headers of a route it will not let the caller call is disclosure for nothing.
      if (allowed) {
        c.header("Access-Control-Allow-Methods", entry.allowMethods);
        c.header("Access-Control-Allow-Headers", entry.allowHeaders);
        c.header("Access-Control-Max-Age", String(maxAgeSeconds));
      }
      // `c.body(null, 204)`, never `new Response(null, …)`: a raw Response drops everything set above,
      // because Hono only merges headers onto a response it built itself.
      return c.body(null, 204);
    }

    // On the real response, and only there — `Access-Control-Expose-Headers` means nothing on a
    // preflight. Set even where the origin is not allowed, because the header is inert without the
    // `Access-Control-Allow-Origin` that gates it, and branching would be a second rule to keep true.
    c.header("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    await next();
  };
}

/**
 * Mount one `app.use(path, …)` per entry.
 *
 * **Called from the capability's `middleware` hook, never its `routes` hook, and that is load-bearing.**
 * `createBackend` runs every capability's `middleware` hook before **any** capability's `routes` hook
 * (`createBackend.ts:262-267`), which is what makes this independent of the order an adopter happens to
 * list their capabilities in.
 *
 * From `routes` it looks like it works and does not. The preflight still answers — an `OPTIONS` has no
 * route handler to lose to, so this `use` is the only thing that matches it — but a capability composed
 * *before* the seam has already registered its terminal handler, and a terminal handler never calls
 * `next()`, so the middleware after it never runs. The real response then carries no
 * `Access-Control-Allow-Origin` and the browser blocks a `200` the caller was entitled to read: a
 * preflight that passes and a read that fails, which is a worse failure than the one this fixes because
 * it looks configured. `cors.test.ts` §"the registration slot" pins it by composing the seam last.
 *
 * Exact paths, never a wildcard: `app.use` on a literal path does not match subpaths, so "nothing
 * outside the control-plane surface gains a CORS header" is structural rather than a check that could
 * be got wrong.
 */
export function registerControlPlaneCors(
  app: Hono<PithyHonoEnv>,
  surface: readonly CorsSurfaceEntry[],
  origins: ReadonlySet<string>,
  maxAgeSeconds: number,
): void {
  for (const entry of surface) app.use(entry.path, corsMiddleware(entry, origins, maxAgeSeconds));
}
