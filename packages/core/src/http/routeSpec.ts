// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MiddlewareHandler } from "hono";
import type { z } from "zod";
import type { VerificationStrategy } from "./verification";

/**
 * The third half of a route declaration. `validate` says what a caller may send and the guards say who
 * may send it; this says what the route is for, how its caller is verified, and what comes back. It is
 * the part the OpenAPI contract (`../openapi/document.ts`) cannot read from anywhere else: a guard is an
 * anonymous closure, and a handler's `c.json(… satisfies Response)` is a compile-time check that leaves
 * nothing behind at runtime.
 *
 * It sits first on the route line, ahead of the guards, and does nothing when it runs but call `next`.
 * Its whole value is the spec it carries under {@link ROUTE_SPEC}, which a reader of the composed app
 * finds by walking `app.routes`.
 *
 * ```ts
 * app.get(
 *   `${base}/:board/top`,
 *   describeRoute({ summary: "Read the top of a board.", verification: ["bearer", "session"], responses: { 200: TopPage } }),
 *   requireAuth(),
 *   validate("param", BoardParam),
 *   handler,
 * );
 * ```
 */

/** The key a {@link describeRoute} middleware carries its spec under. Global, so two copies of core agree. */
export const ROUTE_SPEC = Symbol.for("pithy.routeSpec");

/** One response a route can give that is not a JSON body: bytes, a redirect, HTML, or nothing at all. */
export interface RouteResponse {
  /** What this response means, in one sentence. */
  readonly description: string;
  /** The JSON body, when there is one. Its input side is the wire: what a client parses with it. */
  readonly schema?: z.ZodType;
  /** The media type when the body is not JSON, e.g. `text/html` or `application/octet-stream`. */
  readonly contentType?: string;
}

/** The HTTP methods an `app.all` route is documented under. OpenAPI has no "any method". */
export type DocumentedMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

/** What a route is for, how its caller is verified, and what it returns. */
export interface RouteSpec {
  /** One sentence, in the brand voice. The operation's title in the contract. */
  readonly summary: string;
  /** Anything a client author must know that the schemas do not say. */
  readonly description?: string;
  /**
   * How the caller is verified. A list when the route takes more than one — `requireAuth()` accepts a
   * bearer token or a session, so most authenticated routes declare both.
   */
  readonly verification: VerificationStrategy | readonly VerificationStrategy[];
  /** Scopes the caller's credential must carry, beyond being verified. */
  readonly scopes?: readonly string[];
  /**
   * Every success response, by status. A Zod schema is a JSON body described by the schema itself; a
   * {@link RouteResponse} covers everything else. Errors are not listed: every route can answer with the
   * one `PithyError` body, and the contract says so once.
   */
  readonly responses: Readonly<Record<number, z.ZodType | RouteResponse>>;
  /** For an `app.all` route only: the methods it is documented under. */
  readonly methods?: readonly DocumentedMethod[];
}

/** Declare what a route is for, how its caller is verified, and what it returns. See {@link RouteSpec}. */
export function describeRoute(spec: RouteSpec): MiddlewareHandler {
  const middleware: MiddlewareHandler = async (_c, next) => {
    await next();
  };
  return Object.assign(middleware, { [ROUTE_SPEC]: spec });
}

/** The spec a {@link describeRoute} middleware carries, or `undefined` for any other handler. */
export function routeSpecOf(handler: unknown): RouteSpec | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as { [ROUTE_SPEC]?: RouteSpec })[ROUTE_SPEC];
}
