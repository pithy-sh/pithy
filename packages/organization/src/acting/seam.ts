// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type ActingOrganization, memoizeActing } from "@pithy-sh/core/src/access/acting";
import type { PithyHonoEnv, PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Context } from "hono";
import { organizationDatabase } from "../data/tables";
import type { RoleCatalog } from "../roles/roles";
import { resolveActing } from "./acting";

/**
 * Tenancy's half of core's acting-organization seam: the middleware that publishes
 * `c.var.actingOrganization` for every request, so media and storage can scope a record to the
 * organization a caller acts for without importing this package.
 *
 * **It publishes a resolver and reads nothing.** Most requests never ask, and the answer is a D1 read, so
 * the read happens on the first `await c.var.actingOrganization()` and never again for that request. The
 * session is read at that moment too, not when the middleware runs — so it does not matter whether the
 * adopter listed `organization()` before or after `auth()`.
 *
 * **The answer is {@link resolveActing}'s, exactly.** The session's selection, rejoined against a live
 * membership and its role decoded through the catalog — the same answer `requireOrganization` gives a
 * tenanted route, so a record a media route writes and a gate a tenancy route passes cannot disagree about
 * which organization is in force. No session, or a session that has chosen nothing, is `null`. A role the
 * catalog does not know refuses, as it does on every tenancy route.
 *
 * **`roleAllows` asks the catalog, never a role's spelling.** A power is a string at this seam, and a power
 * the catalog does not declare allows nothing.
 */
export function actingOrganizationMiddleware<Power extends string, Role extends string>(
  catalog: RoleCatalog<Power, Role>,
  binding = "DB",
): PithyMiddleware {
  return (app) => {
    app.use("*", async (c, next) => {
      c.set(
        "actingOrganization",
        memoizeActing(() => resolveFor(c, catalog, binding)),
      );
      await next();
    });
  };
}

/** Resolve the organization this request acts for, off the session `auth` holds now. */
async function resolveFor<Power extends string, Role extends string>(
  c: Context<PithyHonoEnv>,
  catalog: RoleCatalog<Power, Role>,
  binding: string,
): Promise<ActingOrganization | null> {
  const auth = c.var.auth;
  if (!auth) return null;
  const d1 = c.env[binding];
  if (!d1) {
    throw new InternalError({
      message: "The organization database is not configured.",
      action: `Bind a D1 database named ${binding} in wrangler.jsonc, then redeploy.`,
      detail: `the acting-organization seam requires a "${binding}" D1 binding; none was present on env`,
    });
  }
  const acting = await resolveActing(organizationDatabase(d1 as D1Database), catalog, {
    userId: auth.userId,
    sessionId: auth.sessionId,
  });
  if (!acting) return null;
  const role = acting.role;
  return {
    organizationId: acting.organizationId,
    roleAllows: (power) =>
      (catalog.powers as readonly string[]).includes(power) && catalog.roleAllows(role, power as Power),
  };
}
