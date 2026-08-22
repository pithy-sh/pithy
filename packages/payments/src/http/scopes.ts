// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Payments' control-plane scopes, and the admin surface a manifest advertises.
 *
 * **Separate from `guards.ts` because a scope name is a client's business** (#315). A management
 * client reads these to render what a connection may do, and `pithy-sh/dashboard`'s scope builder
 * writes the `pithy dashboard connect --scope …` command from exactly these constants — in a browser
 * program, with the DOM lib and no Workers types. While they sat beside the Hono middleware, naming
 * one compiled `PithyHonoEnv`, which reached core's `capability.ts`, which named Worker globals that
 * program has none of. **This module imports types and nothing else, and a gate holds it there**:
 * `tooling/browser-scopes` compiles a DOM-only program against every scope the kit declares.
 *
 * ## Two scopes, not one admin flag
 *
 * The interim gate checked a single `payments:admin` scope on the `AuthContext`. That string is a valid
 * {@link ControlPlaneScope} — it matches the seam's pattern, so nothing forced this change — but it names a
 * *credential holder*, and the seam's scopes name *operations*. Under that model one flag is wrong on the
 * merits: granting and revoking an entitlement are two operations with different blast radii and different
 * holders. **Grant** mints paid product out of nothing, so a compromised comp tool costs revenue and can
 * escalate itself into anything the catalog sells. **Revoke** takes paid access away from a live customer, so
 * a compromised refund tool is an outage for people who paid. A refund tool needs revoke and never grant; a
 * support-comp tool needs grant and never revoke. One flag makes each of them the other, and an adopter who
 * wanted to hand out only the safer half had no way to say so.
 *
 * The split is real rather than cosmetic because `scopeCovers` matches exactly, with no prefix or wildcard
 * rule: `payments:entitlements` confers neither of these, and holding one confers nothing about the other.
 *
 * The names are constants rather than config, for the reason the old comment gave and which has not changed: a
 * configurable scope name is a way to misconfigure a default-denied gate into a differently-named one, and
 * support tooling that read the docs would then quietly hold a scope nothing checks. They are also the join
 * key with what `pithy dashboard connect` offers an adopter to grant, so they must be the same strings in both
 * places.
 */

/**
 * Minting a discount — an administrative act with a cost attached, and its own scope for that reason.
 *
 * Deliberately not covered by, and not covering, the entitlement grants. Comping somebody an entitlement and
 * creating a code that reduces what everybody who holds it pays are different powers with different blast
 * radii, and a tool that needs one must not acquire the other. `scopeCovers` matches exactly.
 */
export const PAYMENTS_DISCOUNT_CREATE_SCOPE: ControlPlaneScope = "payments:discounts:create";

/**
 * Reading the codes this project has issued.
 *
 * Separate from creating one, and strictly narrower: a pane that lists what was minted does not need the
 * power to mint. The read exists because the write does — a management client that can create a code and
 * never see it leaves a pane computing *absent* rather than blocked, which no grant repairs (#247).
 */
export const PAYMENTS_DISCOUNT_READ_SCOPE: ControlPlaneScope = "payments:discounts:read";

/**
 * Write an entitlement nobody paid for — a comp, or the repair of a purchase that verified and never
 * projected. The more dangerous of the two: a connection holding this can give any account anything the
 * catalog sells.
 */
export const PAYMENTS_ENTITLEMENT_GRANT_SCOPE: ControlPlaneScope = "payments:entitlements:grant";

/**
 * Take an entitlement back — a chargeback, an abuse decision, a comp withdrawn. Effective on the account's
 * next request, which is exactly why it is granted separately from the ability to hand one out.
 */
export const PAYMENTS_ENTITLEMENT_REVOKE_SCOPE: ControlPlaneScope = "payments:entitlements:revoke";

/**
 * Read the purchase log — every verified provider transaction, across every account.
 *
 * Strictly more disclosure than {@link PAYMENTS_SUBSCRIPTIONS_READ_SCOPE}, which is why the two are
 * separate: a renewal monitor needs to know who is still paying and when their period ends, and has no
 * business reading what everybody ever bought. Neither read reaches a stored provider payload.
 */
export const PAYMENTS_PURCHASES_READ_SCOPE: ControlPlaneScope = "payments:purchases:read";

/**
 * Read the purchases that renew — the same rows as the purchase log, narrowed to `type: subscription`.
 *
 * The narrower of the two grants, and the one a renewal or churn tool should hold on its own. Holding it
 * confers nothing about the rest of the log: `scopeCovers` matches exactly, with no prefix rule.
 */
export const PAYMENTS_SUBSCRIPTIONS_READ_SCOPE: ControlPlaneScope = "payments:subscriptions:read";

/**
 * Read the entitlement model — what accounts hold, whether it grants right now, and where it came from.
 *
 * **The read that had to exist for grant and revoke to be honest.** Payments shipped both writes with no
 * read beside them, so a management client could comp an entitlement and take one back while never being
 * able to list one; a console that cannot see what it changed is asking an operator to act blind. It is
 * still granted separately, because seeing what every account is entitled to and deciding what they are
 * entitled to are different operations with different blast radii.
 */
export const PAYMENTS_ENTITLEMENTS_READ_SCOPE: ControlPlaneScope = "payments:entitlements:read";

/**
 * Read what this project **sells** — each product's id, type, display name, and the entitlement keys it
 * grants. Not what anybody bought.
 *
 * **Its own scope, and the reason is that the two disclosures are unrelated.** Every other read here is a
 * page of the adopter's customers: who paid, what they hold, when it lapses. This one names no account and
 * no transaction, and would read identically against a database with no rows in it. A tool that populates a
 * "comp this person an entitlement" list needs exactly this and nothing else, and it should be able to hold
 * exactly this and nothing else — a dropdown is not a reason to hand a client the purchase log.
 *
 * The converse matters as much and is why it is not folded into {@link PAYMENTS_ENTITLEMENTS_READ_SCOPE}: a
 * catalog is a commercial fact — every tier a company sells and every feature it gates — and a connection
 * granted the entitlement model should not acquire it by implication. `scopeCovers` matches exactly, so
 * neither scope confers the other.
 */
export const PAYMENTS_CATALOG_READ_SCOPE: ControlPlaneScope = "payments:catalog:read";

/**
 * Read what **reconciliation** did — the log of passes, their tallies, and when they last ran.
 *
 * Its own scope because it is operational state rather than anybody's commerce. A run record names no
 * account, no transaction and no amount; it says whether the compensating control for a delivery mechanism
 * that is known to fail has been firing, and how much it had to repair. An adopter should be able to give a
 * health monitor exactly that and nothing else — a "has the cron stopped" alarm has no business holding the
 * purchase log, and `scopeCovers` matches exactly, so neither confers the other.
 */
export const PAYMENTS_RECONCILE_READ_SCOPE: ControlPlaneScope = "payments:reconcile:read";

/**
 * Every control-plane scope payments defines — what `pithy dashboard connect` offers for this capability, and
 * the list a manifest or a doc quotes rather than re-typing. Core's `SEAM_SCOPES` is the same idea for the
 * seam's own routes.
 *
 * Reads first, writes after, because that is the order an adopter should read them in: the reads are the
 * grant most connections want and the smallest one that makes a dashboard useful.
 */
export const PAYMENTS_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  PAYMENTS_CATALOG_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_DISCOUNT_READ_SCOPE,
  PAYMENTS_RECONCILE_READ_SCOPE,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
  PAYMENTS_DISCOUNT_CREATE_SCOPE,
];

/**
 * Payments' management surface, as `GET /control-plane/manifest` reports it.
 *
 * Declared beside the scopes rather than in `routes.ts` so the scope a route demands and the scope a
 * manifest advertises are the same constant, read from one place. `basePath` is a parameter and never a
 * default: an adopter who mounted payments at `/billing` must get a manifest naming
 * `/billing/entitlements/grant`, or a management client composing its calls from it would 404 against
 * exactly the adopters who customized anything.
 *
 * The summaries say what the operation *is for*, not what it does mechanically. A client renders these
 * next to a button somebody is about to press on a paying customer's account.
 *
 * **Everything sits under an `admin/` segment.** The player surface already owns `${basePath}/purchases`
 * and `${basePath}/entitlements`, and the second of those is a `GET` — so a management read mounted at
 * the bare path would either collide outright or sit behind whichever of the two Hono matched first, with
 * a route's gate decided by registration order. The extra segment makes the two sets disjoint by
 * construction rather than by luck. It also keeps the reads at the shape a management client looks for: a
 * `GET`, with a declared scope, no `:` segment, ending in the resource's own noun.
 */
export function paymentsAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/admin/catalog`,
      scope: PAYMENTS_CATALOG_READ_SCOPE,
      summary:
        "What this project sells — each product's id, kind, display name, and the entitlement keys it grants. The list a comp control fills its dropdown from.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/purchases`,
      scope: PAYMENTS_PURCHASES_READ_SCOPE,
      summary:
        "Page the purchase log — every verified transaction, newest first, filtered by holder (both halves of the subject), store, status or store environment.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/subscriptions`,
      scope: PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
      summary: "Page the purchases that renew — who is still paying, and when the period they paid for ends.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/entitlements`,
      scope: PAYMENTS_ENTITLEMENTS_READ_SCOPE,
      summary: "Page what accounts hold — whether each entitlement grants right now, and which purchase is the reason.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/entitlements/:subjectType/:subjectId`,
      scope: PAYMENTS_ENTITLEMENTS_READ_SCOPE,
      summary:
        "Everything one subject is entitled to, resolved now — addressed by both halves, `user`/`organization` and the id. The answer to “why can this person not use what they paid for”.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/discounts`,
      scope: PAYMENTS_DISCOUNT_READ_SCOPE,
      summary: "The discount codes this project has issued, read from the store that holds them.",
    },
    {
      method: "POST",
      path: `${basePath}/admin/discounts`,
      scope: PAYMENTS_DISCOUNT_CREATE_SCOPE,
      summary: "Mint a discount code at one store, from terms stated in the units a customer experiences.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/reconcile-runs`,
      scope: PAYMENTS_RECONCILE_READ_SCOPE,
      summary:
        "The reconciliation passes this deployment has run — when each ran, what it compared, and what it had to repair. The answer to whether the nightly repair is still firing.",
    },
    {
      method: "POST",
      path: `${basePath}/entitlements/grant`,
      scope: PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
      summary: "Comp an entitlement, or repair a purchase that verified but never projected.",
    },
    {
      method: "POST",
      path: `${basePath}/entitlements/revoke`,
      scope: PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
      summary: "Take an entitlement back, effective immediately.",
    },
  ];
}
