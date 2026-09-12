// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyVars } from "@pithy-sh/core/src/capability/capability";
import { UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { Context, MiddlewareHandler } from "hono";
import {
  type ActingMembership,
  hasAnyMembership,
  noSuchOrganization,
  resolveActing,
  resolveActingIn,
} from "../acting/acting";
import type { OrganizationDatabase } from "../data/tables";
import { OrganizationForbiddenError, OrganizationNotFoundError } from "../error/errors";
import type { KitPower, RoleCatalog } from "../roles/roles";

/**
 * The gates a tenanted route composes.
 *
 * ```ts
 * app.get("/admin/coaches",
 *   requireAuth(),
 *   requireOrganization(deps),        // fills c.var.acting, or 404s
 *   requirePower("members:manage", deps),
 *   handler,
 * );
 * ```
 *
 * ## `acting` is a second context variable, not a field on `auth`
 *
 * `auth` says who is signed in, and the auth capability fills it for every request carrying a
 * credential. `acting` says what they are entitled to **here**, and exists only where a gate has proved
 * it. Merging them would make "signed in" and "a member of this organization" one condition, and the
 * whole point is that they are two — the same reason core keeps `controlPlane` separate from `auth`
 * rather than treating a management client as a very privileged user.
 *
 * A route that did not mount {@link requireOrganization} therefore has no `acting` to read. That is the
 * property, and `guard.workers.test.ts` asserts it rather than trusting the type.
 *
 * ## The gate fails closed on its own
 *
 * The session is checked here, not merely upstream. A route that mounted this and forgot `requireAuth()`
 * must answer 401, not resolve an organization for `undefined` — depending on middleware ordering for a
 * security property means the property holds until somebody reorders a line.
 *
 * ## Two refusals, and the difference between them is earned
 *
 * {@link OrganizationNotFoundError} (404) is what a caller gets for an organization that does not exist
 * **and** for one they are not in, byte for byte. A distinguishable answer is an existence oracle, and
 * iterating it produces the tenant list; the real distinction rides in `detail`, which the HTTP codec
 * strips and the log keeps.
 *
 * {@link OrganizationForbiddenError} (403) is what a **proved member** gets when their role is short of
 * the power. By then they already know the organization exists, because they belong to it, so naming
 * the shortfall leaks nothing further and is the only answer that lets them go and ask for the power.
 *
 * The third sentence is neither: a caller with no organization in force is told so in wording that names
 * no organization, because there is none to name. It is a fact about their own rows.
 */

/** The Hono `Variables` a tenanted route sees: the base seam, plus the membership a gate proved. */
export type OrganizationVars<Role extends string = string> = PithyVars & {
  /**
   * The resolved membership. **Present only downstream of {@link requireOrganization}**, and
   * non-optional there — the one place a handler should learn the organization, the acting person, or
   * their role.
   */
  acting: ActingMembership<Role>;
};

/**
 * The Hono env tenanted routes are typed against.
 *
 * Exported so an adopter's handler reads `c.var.acting` without a null check and with `role` narrowed
 * to the names their catalog declared. Routes are mounted on a `Hono<OrganizationHonoEnv<Role>>`, the
 * same way the base seam's `PithyHonoEnv` is used everywhere else.
 */
export type OrganizationHonoEnv<Role extends string = string> = {
  Bindings: Record<string, unknown>;
  Variables: OrganizationVars<Role>;
};

/**
 * What the gates need, resolved once at compose time.
 *
 * **`database` takes the worker env rather than the request context, and that is the honest signature
 * rather than a convenience.** A binding belongs to the invocation, so it is read per request; but the
 * only thing this needs off a request is `c.env`, and Hono's context is invariant in its env — a
 * function typed on a context could not be handed one typed on the base seam, which is exactly what a
 * gate running before any organization is resolved holds.
 */
export interface OrganizationGuardDeps<Power extends string = string, Role extends string = string> {
  /** The project's declared catalog. Every authorization question in this package is asked of it. */
  readonly catalog: RoleCatalog<Power, Role>;
  /** The tenancy database, built from this invocation's D1 binding. */
  readonly database: (env: Record<string, unknown>) => OrganizationDatabase;
}

/**
 * Where a route names an organization, for the routes that address one directly.
 *
 * Most routes name none: the answer is the session's selection, and a URL that cannot name another
 * tenant cannot be pointed at one. An admin surface addressed by id is the exception, and it says so at
 * the mount rather than reading an id inside a handler that has already been let through.
 *
 * **It names a validated target, not a raw one.** The id is read back through `c.req.valid(...)`, so the
 * route must declare it on the route line with `zValidator(target, Schema, validationHook)` — the kit's
 * request contract, and the reason nothing in this package reaches `c.req.param()` or `c.req.query()`.
 * A route that named an organization and declared no schema for it has nothing to read, and the gate
 * refuses rather than guessing.
 */
export interface NamedOrganization {
  /** Which validated target carries the id — the path parameters, or the query string. */
  readonly from: "param" | "query";
  /** The field's name in that target — `organizationId` on a route mounted at `/:organizationId`. */
  readonly name: string;
}

/**
 * The organization a route named, off the validated request.
 *
 * The target is configuration here, so the shape of the validated bag cannot be known at this point and
 * is read structurally — checked to be a string before it is used, and proved against a membership
 * immediately after. `c.req.valid` is the only accessor this package reaches for, which is what makes
 * "every route declares what it accepts" structural rather than a convention.
 */
function namedOrganizationId<Role extends string>(
  c: Context<OrganizationHonoEnv<Role>>,
  named: NamedOrganization,
): string | undefined {
  const request = c.req as unknown as { valid: (target: "param" | "query") => unknown };
  const validated = request.valid(named.from);
  if (typeof validated !== "object" || validated === null) return undefined;
  const value = (validated as Record<string, unknown>)[named.name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Fill `c.var.acting`, or refuse.
 *
 * With no {@link NamedOrganization}, the answer is the session's selection, rejoined against a live
 * membership. With one, it is the organization the route named, proved against a membership of the
 * caller in the same predicate.
 *
 * **A named organization that is absent from the request refuses; it never falls back to the session.**
 * That fallback is the dangerous shape: a route written to act on the organization in its path would
 * sometimes act on a different one, and the request that triggered it would look like a routing typo
 * rather than a tenancy breach.
 */
export function requireOrganization<Power extends string, Role extends string>(
  deps: OrganizationGuardDeps<Power, Role>,
  named?: NamedOrganization,
): MiddlewareHandler<OrganizationHonoEnv<Role>> {
  return async (c, next) => {
    // Checked here as well as upstream. This gate is the last thing between a request and whatever the
    // tenant owns, so it assumes nothing about what ran before it.
    const auth = c.var.auth;
    if (!auth) {
      throw new UnauthorizedError({
        message: "Sign in to continue.",
        action: "Retry with a valid session or bearer token.",
        detail: "requireOrganization ran with no resolved session",
      });
    }

    const db = deps.database(c.env);

    if (named) {
      const organizationId = namedOrganizationId(c, named);
      if (!organizationId) {
        throw noSuchOrganization(
          `route declares a validated ${named.from} named ${named.name}; the request carried none`,
        );
      }
      const acting = await resolveActingIn(db, deps.catalog, { userId: auth.userId, organizationId });
      if (!acting) {
        throw noSuchOrganization(`user ${auth.userId} has no membership in organization ${organizationId}`);
      }
      c.set("acting", acting);
      await next();
      return;
    }

    const acting = await resolveActing(db, deps.catalog, { userId: auth.userId, sessionId: auth.sessionId });
    if (!acting) throw await noOrganizationInForce(db, auth.userId);
    c.set("acting", acting);
    await next();
  };
}

/**
 * Demand a power, or refuse with a 403.
 *
 * Asks the catalog and nothing else. A power is never inferred from a role's spelling, and a role is
 * never read from a session claim — by the time this runs, `acting.role` came off a membership row on
 * this request.
 *
 * The signature takes the power from the catalog's own union, so a power nobody declared is a compile
 * error at the route rather than a gate that silently denies everyone.
 */
export function requirePower<Power extends string, Role extends string>(
  power: KitPower | Power,
  deps: OrganizationGuardDeps<Power, Role>,
): MiddlewareHandler<OrganizationHonoEnv<Role>> {
  return async (c, next) => {
    const acting = c.var.acting;
    if (!acting) {
      // Not a caller's mistake — a route that stacked this without `requireOrganization()` above it. It
      // refuses rather than reading a role off nothing, because the alternative is a gate whose answer
      // depends on where it was mounted.
      throw new OrganizationForbiddenError({
        detail: `requirePower(${power}) ran with no resolved membership; mount requireOrganization() first`,
      });
    }
    if (!deps.catalog.roleAllows(acting.role, power)) {
      throw new OrganizationForbiddenError({
        message: `Your role in this organization does not allow \`${power}\`.`,
        detail: `role ${acting.role} does not hold ${power} in organization ${acting.organizationId}`,
      });
    }
    await next();
  };
}

/*
  **There is no `requireMayAssign` here, and its absence is the rule.**

  Offering an administering role in an invitation and promoting a member to it are the same act arriving
  by two doors, and the acceptance criterion is that *one* function answers it. A curried copy in this
  file would have been a second implementation of that answer — correct on the day it was written, and
  one edit away from disagreeing with the other. `changeRole` calls
  `../members/members.ts#requireMayAssign` internally and the invitation route calls the same export,
  so both doors reach one function because there is only one to reach.
*/

/**
 * The refusal when a session has no organization in force.
 *
 * Two sentences, and the second query is what earns them. Belonging nowhere is answered by an
 * invitation; belonging somewhere without having chosen is answered by a chooser, and telling somebody
 * to go and get invited when they already have three accounts is a worse answer than the extra read
 * costs. Neither names an organization, because both are facts about the caller's own rows — which is
 * why they may be said plainly where "that organization does not exist" may not.
 */
async function noOrganizationInForce(db: OrganizationDatabase, userId: string): Promise<OrganizationNotFoundError> {
  const belongs = await hasAnyMembership(db, userId);
  return new OrganizationNotFoundError({
    message: "No organization is in force.",
    action: belongs ? "Choose an organization to continue." : "Join or create an organization to continue.",
    detail: belongs
      ? `user ${userId} holds a membership but this session has selected nothing`
      : `user ${userId} has no membership in any organization`,
  });
}
