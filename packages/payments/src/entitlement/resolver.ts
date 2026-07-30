import type { PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import type { Entitlement, EntitlementResolver } from "@pithy-sh/core/src/entitlement/entitlement";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { PaymentsDatabase } from "../data/tables";
import { resolveEntitlements } from "../projection/resolve";

/**
 * Payments filling the entitlement seam. Core's default (`noEntitlementProvider`) holds nothing so that an
 * uncomposed gate denies; this replaces it with a resolver over the materialized read model in D1.
 *
 * The name payments answers under. `requireEntitlement()` puts it in `detail` on a denial, which is what
 * lets an operator tell "genuinely unentitled" from "nothing wired" without telling a client either.
 */
export const PAYMENTS_ENTITLEMENT_PROVIDER = "payments";

/** A resolver for one user, over one database. The whole seam: who is asking is already decided. */
export function createPaymentsEntitlementResolver(
  db: PaymentsDatabase,
  userId: string,
  now: () => Date = () => new Date(),
): EntitlementResolver {
  return {
    provider: PAYMENTS_ENTITLEMENT_PROVIDER,
    list: () => resolveEntitlements(db, userId, now()),
  };
}

/**
 * The middleware that installs the resolver, per request, over `c.var.db.<database>`.
 *
 * **Everything is resolved inside `list()`, not around it, and that is the point.** Middleware order is the
 * adopter's — it follows the order of the `capabilities` array in their `pithy.config.ts` — so this
 * middleware may well run before `@pithy-sh/auth` has set `c.var.auth`. Reading the caller at gate time
 * rather than at install time makes the resolver correct whatever that order is, and it means a request that
 * never gates on an entitlement never builds a Kysely instance or touches D1.
 *
 * With no authenticated caller there is nobody to resolve for, so the resolver holds nothing. It still names
 * payments as the provider, because payments *is* composed — an anonymous caller is a 401 from the gate, not
 * a composition problem, and reporting `null` here would send an operator looking for a missing capability.
 */
export function installEntitlementResolver(database: string): PithyMiddleware {
  return (app) => {
    app.use("*", async (c, next) => {
      c.set("entitlements", {
        provider: PAYMENTS_ENTITLEMENT_PROVIDER,
        list: async (): Promise<readonly Entitlement[]> => {
          const auth = c.var.auth;
          if (!auth) return [];
          const db = (c.var.db as Record<string, PaymentsDatabase>)[database];
          if (!db) {
            // Unreachable through `createBackend`, which validates the `DB` binding at boot. Thrown rather
            // than returned as an empty list so the gate's own catch logs the wiring fault: a silent empty
            // list denies correctly but looks identical to a user who simply has not bought anything.
            throw new InternalError({
              message: "Payments is not configured.",
              action: "Bind a D1 database named DB in wrangler.jsonc.",
              detail: `No \`${database}\` database on c.var.db; payments cannot resolve entitlements.`,
            });
          }
          return resolveEntitlements(db, auth.userId, new Date());
        },
      });
      await next();
    });
  };
}
