// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MiddlewareHandler } from "hono";
import type { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import { ForbiddenError, UnauthorizedError } from "../error/pithyError";
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

/**
 * What a tool does beyond reading, which every non-`GET` tool must say (`docs/AGENT-ACCESS.md` §4).
 *
 * **A route is a tool only when it says so, and a non-`GET` says so louder.** One that sends mail, charges a card or
 * deletes something is a tool an agent can call in a loop, so the effect is not inferred from the method: it is
 * declared, it sets the tool's MCP annotations, it is written into the tool's description, and it is counted on the
 * consent screen beside its capability.
 */
export const TOOL_EFFECTS = ["writes", "sends", "charges", "deletes"] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

/**
 * A route's opt-in to the app's MCP endpoint. `true` is a read, and only a `GET` may say it; anything else declares
 * its {@link ToolEffect}. `createBackend` refuses a composition where either half is wrong — `describeRoute` cannot
 * see the method it is mounted under, so the composition is the first place the pair can be checked.
 */
export type RouteTool = true | { readonly effect: ToolEffect };

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
  /**
   * The power a caller's role must hold to reach this route at all. **Declaring it installs the gate**: the
   * same middleware that carries this spec refuses a caller whose acting organization's role does not hold it, so
   * what the MCP endpoint filters `tools/list` on and what the route enforces are one value and cannot drift.
   *
   * A route whose access depends on the record — its owner may, a manager may — declares the power that lets a
   * member reach it at all, and keeps its in-handler check. Absent, the route is gated by its other guards alone,
   * and a tool for it is offered to every signed-in user the endpoint admits.
   */
  readonly power?: string;
  /**
   * The route's permanent name within its capability, e.g. `threads.reply`. Its MCP tool is
   * `<capability>_<operation>`, through the one normalizer the control-plane server's tools use. Unique within a
   * capability, and never renamed once published: an agent references a tool by name.
   */
  readonly operation?: string;
  /**
   * The route's opt-in to the app's MCP endpoint. Absent, the route is not a tool. See {@link RouteTool}.
   */
  readonly tool?: RouteTool;
}

/**
 * Declare what a route is for, how its caller is verified, and what it returns. See {@link RouteSpec}.
 *
 * With a {@link RouteSpec.power} it is also the route's power gate, read off the acting-organization seam the way
 * every capability outside tenancy asks it. It sits first on the route line, so it answers an anonymous caller
 * itself rather than assuming a guard below it will: a 401, because signing in might help, where a role that does
 * not hold the power is a 403.
 */
export function describeRoute(spec: RouteSpec): MiddlewareHandler {
  const { power } = spec;
  const middleware: MiddlewareHandler<PithyHonoEnv> =
    power === undefined
      ? async (_c, next) => {
          await next();
        }
      : async (c, next) => {
          if (!c.var.auth) {
            throw new UnauthorizedError({
              message: "Authentication required.",
              action: "Sign in and retry with a valid session or bearer token.",
              detail: `describeRoute(power: ${power}) ran with no signed-in caller`,
            });
          }
          const acting = await c.var.actingOrganization();
          if (acting === null || !acting.roleAllows(power)) {
            throw new ForbiddenError({
              message: `Your role does not allow \`${power}\`.`,
              detail:
                acting === null
                  ? `no organization is in force for user ${c.var.auth.userId}, so ${power} is not held`
                  : `the role in organization ${acting.organizationId} does not hold ${power}`,
            });
          }
          await next();
        };
  return Object.assign(middleware as MiddlewareHandler, { [ROUTE_SPEC]: spec });
}

/** The spec a {@link describeRoute} middleware carries, or `undefined` for any other handler. */
export function routeSpecOf(handler: unknown): RouteSpec | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as { [ROUTE_SPEC]?: RouteSpec })[ROUTE_SPEC];
}
