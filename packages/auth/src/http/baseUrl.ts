// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type AmbientEnv, ambientEnv, compositionEnvironment } from "@pithy-sh/core/src/env/ambient";

/**
 * Where a composition's base URL comes from — and therefore what its session cookie is called, and
 * which origin its CSRF gate calls its own.
 *
 * ## The shape, and the two that lost
 *
 * `baseURL` stays **one string, and it means the deployed origin**. A `dev` composition does not read
 * it: it resolves its base URL from the host the request actually arrived on, over `http`.
 *
 * A per-environment record (`{ prod, staging, dev }`, the way a Worker's `domains` block reads) was the
 * obvious shape and it fails on the one value it exists to hold. The dev port is assigned per Worker per
 * run from the feature's reserved block, so `dev: "http://localhost:8787"` is wrong the moment a second
 * Worker starts or that port is taken — and a record whose `dev` key must be left empty to be correct is
 * a field that only ever holds a mistake.
 *
 * Resolving from the request is what survives that, because the request is the only thing that knows the
 * port. It cannot be stale, it needs no cooperation from `pithy dev`, and nothing has to be written down.
 *
 * ## We run no TLS locally, so the scheme is a constant
 *
 * That is settled policy, and it is what makes the rest hold **by construction** rather than by comment.
 * `devBaseURL` fixes the scheme and takes only the host; {@link sessionCookieName} reads only the scheme.
 * So the part nobody can know ahead of time — the port — cannot reach the cookie name, and the part that
 * decides the cookie name is a constant. The dev seed and the running composition agree because they are
 * reading the same two lines, not because they were written on the same day.
 *
 * ## One gate, on the environment alone
 *
 * {@link baseURLResolver} contains the only environment test in this seam: one `if`, on
 * `compositionEnvironment` and nothing else, and-ed and or-ed with nothing. Outside `dev` it returns the
 * configured value verbatim for every request, so a staging or production Worker resolves exactly what it
 * resolved before this module existed — and the same-origin set it builds is byte-identical, because the
 * origin the gate adds is the origin the configured base URL already contributed.
 *
 * `undefined` — nothing stamped `ENVIRONMENT` — is not `dev`, which is `compositionEnvironment`'s own
 * rule and the right one here too: a deployment whose `wrangler.jsonc` lost the var must not start
 * trusting whatever host a request claims to have arrived at.
 */

/** The one environment whose base URL is derived from the request rather than read from config. */
const DERIVED_ENVIRONMENT = "dev";

/**
 * The scheme every `dev` composition serves on.
 *
 * Not a default and not a guess: Pithy runs no TLS locally, so there is no second possibility to choose
 * between. It is exported because the dev-session seed needs it to name the cookie it writes, and that
 * agreement is the whole invariant.
 */
export const DEV_PROTOCOL = "http:";

/** Better Auth's session cookie, before any prefix — `<cookiePrefix>.session_token`, prefix unchanged. */
const SESSION_COOKIE = "better-auth.session_token";

/**
 * The base URL a `dev` composition resolves for a request that arrived at `host`.
 *
 * `host`, not `hostname`: the port is the whole point, and it is the part of a dev address that nobody
 * can know before the run allocates it.
 */
export function devBaseURL(host: string): string {
  return `${DEV_PROTOCOL}//${host}`;
}

/**
 * A base URL's scheme, or `""` for a string that is not a URL at all.
 *
 * Tolerant rather than throwing, for the same reason the CSRF gate's `originOf` is: `baseURL` is a
 * `z.string()` an adopter writes by hand, and a malformed one must fail as "no `__Secure-` prefix" —
 * matching what Better Auth itself does with it — not as a 500 on every request.
 */
export function baseURLProtocol(baseURL: string): string {
  try {
    return new URL(baseURL).protocol;
  } catch {
    return "";
  }
}

/**
 * Better Auth's session cookie name for a base URL served over `protocol`.
 *
 * Our mirror of a rule that lives in Better Auth: it adds the `__Secure-` prefix when the base URL is
 * HTTPS. Mirrored because the seed has to name the cookie before any instance exists, and pinned to the
 * running version by a test that reads the name off a live instance — so an upgrade that changed the
 * rule fails there rather than in a browser.
 */
export function sessionCookieName(protocol: string): string {
  return protocol === "https:" ? `__Secure-${SESSION_COOKIE}` : SESSION_COOKIE;
}

/** Resolve the base URL this composition serves under, for one request. */
export type ResolveBaseURL = (request: Request) => string;

/**
 * Build this composition's base-URL resolver. The environment is read once, here, and nowhere else in
 * this seam.
 */
export function baseURLResolver(configured: string, env: AmbientEnv = ambientEnv()): ResolveBaseURL {
  // The gate. Its own condition, on the environment alone — never folded into the per-request check,
  // where a dev relaxation would be one edit away from applying in production.
  if (compositionEnvironment(env) !== DERIVED_ENVIRONMENT) return () => configured;
  return (request) => devBaseURL(new URL(request.url).host);
}
