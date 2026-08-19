// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import type { Entitlement, EntitlementHolder, EntitlementResolver } from "@pithy-sh/core/src/entitlement/entitlement";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { encodeSubjectReference, type PaymentsSubject } from "../data/subject";
import type { PaymentsDatabase } from "../data/tables";
import { resolveEntitlements } from "../projection/resolve";
import { type PaymentsSubjectSeam, resolvePaymentsSubject } from "./subjectSeam";

/**
 * Payments filling the entitlement seam. Core's default (`noEntitlementProvider`) holds nothing so that an
 * uncomposed gate denies; this replaces it with a resolver over the materialized read model in D1.
 *
 * The name payments answers under. `requireEntitlement()` puts it in `detail` on a denial, which is what
 * lets an operator tell "genuinely unentitled" from "nothing wired" without telling a client either.
 */
export const PAYMENTS_ENTITLEMENT_PROVIDER = "payments";

/**
 * How a subject appears in a denial's `detail` and on a denial's audit row — core's {@link EntitlementHolder},
 * which is display text and an audit dimension and **nothing a gate compares**.
 *
 * The label is `encodeSubjectReference`'s form, so the string in a log line is the same string the rails
 * stamp into a store and the same one `pithy payments reconcile --subject` takes. One spelling of a holder
 * across the whole capability means an operator reading a denial can paste it into the support command.
 *
 * **`tenant` is the organization id, or null under per-person billing** — and the null is the honest answer
 * rather than a gap. `AuditEvent.tenant` is the dimension a trail is read by, and a consumer app has no such
 * dimension: the holder is the actor, so a tenant here would echo `actorId` and invent a tenancy the app
 * does not have. Under organization billing it is exactly the value that answers "which of our customers is
 * hitting the paywall", which `actorId` cannot, because one person acts in two organizations.
 */
export function paymentsEntitlementHolder(subject: PaymentsSubject): EntitlementHolder {
  return {
    label: encodeSubjectReference(subject),
    tenant: subject.subjectType === "organization" ? subject.subjectId : null,
  };
}

/**
 * A resolver for one subject, over one database. The whole seam: who is asking is already decided.
 *
 * The subject is the **pair**, never an id — `data/subject.ts` for why both halves travel together. Taking
 * one object rather than two strings is what keeps a caller from transposing them, and what keeps a
 * `subjectType` from config being paired with a `subjectId` from somewhere else.
 */
export function createPaymentsEntitlementResolver(
  db: PaymentsDatabase,
  subject: PaymentsSubject,
  now: () => Date = () => new Date(),
): EntitlementResolver {
  return {
    provider: PAYMENTS_ENTITLEMENT_PROVIDER,
    list: () => resolveEntitlements(db, subject, now()),
    // Unconditional here: this resolver was handed its subject, so there is no case where it cannot say.
    holder: async () => paymentsEntitlementHolder(subject),
  };
}

/**
 * The middleware that installs the resolver, per request, over `c.var.db.<database>`.
 *
 * **Everything is resolved inside `list()`, not around it, and that is the point.** Middleware order is the
 * adopter's — it follows the order of the `capabilities` array in their `pithy.config.ts` — so this
 * middleware may well run before `@pithy-sh/auth` has set `c.var.auth`. Reading the caller at gate time
 * rather than at install time makes the resolver correct whatever that order is, and it means a request that
 * never gates on an entitlement never builds a Kysely instance or touches D1. The subject seam is resolved
 * on the same schedule and for the same reason: an adopter's resolver reads the session, and the session is
 * only on the request once whichever middleware sets it has run.
 *
 * **The subject is resolved first, before the database is even looked for.** With nobody resolved there is
 * nothing to ask D1, so the binding check below has no business running — an organization-billed Worker
 * whose seam answers nothing must read as unentitled, which is a denial from the gate, and not as broken,
 * which is what a 500 from a wiring check would have said. Unanswered is unentitled: see `subjectSeam.ts`
 * for why that is the only safe direction, and why nothing here falls back to `c.var.auth.userId`.
 *
 * With nobody to resolve for, the resolver holds nothing. It still names payments as the provider, because
 * payments *is* composed — an anonymous caller is a 401 from the gate and an unresolved subject is a 403,
 * neither is a composition problem, and reporting `null` here would send an operator looking for a missing
 * capability.
 */
export function installEntitlementResolver(database: string, seam: PaymentsSubjectSeam): PithyMiddleware {
  return (app) => {
    app.use("*", async (c, next) => {
      // **One resolution per request, shared by `list()` and `holder()`.** The seam is the adopter's and
      // usually reads their session — a KV get, a D1 row — and a denial calls both halves, so resolving
      // twice would double that cost on precisely the path that is already failing. Memoizing the
      // *promise* rather than the value also makes two concurrent gates on one request share one read.
      let resolving: Promise<PaymentsSubject | undefined> | undefined;
      const subjectOnce = (): Promise<PaymentsSubject | undefined> => {
        resolving ??= resolvePaymentsSubject(c, seam);
        return resolving;
      };
      c.set("entitlements", {
        provider: PAYMENTS_ENTITLEMENT_PROVIDER,
        // Who the read answered for, for the log and the trail alone. `undefined` is a real answer and a
        // different one from "holds nothing": it is a caller acting for no organization, which is what
        // lets core's denial say so instead of reporting an empty list twice over.
        holder: async (): Promise<EntitlementHolder | undefined> => {
          const subject = await subjectOnce();
          return subject ? paymentsEntitlementHolder(subject) : undefined;
        },
        list: async (): Promise<readonly Entitlement[]> => {
          const subject = await subjectOnce();
          if (!subject) return [];
          const db = (c.var.db as Record<string, PaymentsDatabase>)[database];
          if (!db) {
            // Unreachable through `createBackend`, which validates the `DB` binding at boot. Thrown rather
            // than returned as an empty list so the gate's own catch logs the wiring fault: a silent empty
            // list denies correctly but looks identical to a subject that simply has not bought anything.
            throw new InternalError({
              message: "Payments is not configured.",
              action: "Bind a D1 database named DB in wrangler.jsonc.",
              detail: `No \`${database}\` database on c.var.db; payments cannot resolve entitlements.`,
            });
          }
          return resolveEntitlements(db, subject, new Date());
        },
      });
      await next();
    });
  };
}
