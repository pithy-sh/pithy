// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MiddlewareHandler } from "hono";
import type { PithyHonoEnv } from "../capability/capability";
import { InternalError, messageOf, PithyError, UnauthorizedError } from "../error/pithyError";
import {
  ENTITLEMENT_DENIED_ACTION,
  type EntitlementHolder,
  EntitlementKey,
  grantedEntitlementKeys,
} from "./entitlement";

/**
 * The entitlement gate — the middleware half of the seam. `requireEntitlement("pro")` is the
 * `verification`-strategy sibling every paid route carries: it says what the caller must *hold*, the
 * way `requireAuth()` says who the caller must *be*, and it belongs on the route line beside it.
 *
 *   app.get("/reports", requireAuth(), requireEntitlement("pro"), zValidator(…), handler)
 *
 * It lives in `@pithy-sh/core` rather than in `@pithy-sh/payments` for the same reason `requireAuth()`
 * is copied into each capability instead of imported from `@pithy-sh/auth`: a gate that arrives with a
 * package fails **open** when that package is absent. Depending on the core seam means an uncomposed
 * provider leaves `noEntitlementProvider` on the request, and every gate denies.
 *
 * Two names, not one variadic, because "any of these" and "all of these" are both plausible readings
 * of `requireEntitlement("pro", "team")` and the wrong reading is a security bug rather than a typo.
 */

/**
 * Why a gate denied — recorded in `detail` and in the audit event, never sent to the client.
 *
 * **Three readings, and keeping them apart is the whole job.** Nothing composed is one. A holder that has
 * bought nothing is the second. A caller acting for **no** holder at all is the third — the ordinary state
 * of somebody signed in with no organization selected, and before #412 it was spelled `payments resolved
 * []`, identically to the second. They want opposite fixes: one is a sale, the other is a subject resolver
 * returning nothing, and an operator reading one sentence had no way to tell which they were looking at.
 *
 * The holder is named only when the resolver reports one, and it is named as {@link EntitlementHolder}'s
 * `label` — display text, never a value this gate compares. A resolver that cannot say omits it, and the
 * sentence is exactly what it was.
 */
function denialDetail(
  keys: readonly string[],
  provider: string | null,
  held: ReadonlySet<string>,
  reading: HolderReading,
): string {
  const required = keys.join(" | ");
  if (provider === null) {
    return `no entitlement provider is composed, so \`${required}\` cannot be held. Add a payments capability to this Worker's pithy.config.ts.`;
  }
  switch (reading.kind) {
    // The resolver could have answered and said nobody. Distinct from `failed` below, and the distinction is
    // the point: this is a caller with no organization selected, which is a wiring or session question, not
    // a broken provider.
    case "nobody":
      return `${provider} resolved no holder for this caller, so nothing can be held; the route requires \`${required}\`. Under organization billing this is a caller acting for no organization, not an unentitled one.`;
    // It tried and raised. Saying "no holder" here would send an operator to an unwired resolver when the
    // resolver is wired and erroring — the opposite diagnosis, and the exact ambiguity this sentence set
    // exists to remove. The cause is already on the log line beside this.
    case "failed":
      return `${provider} could not resolve a holder for this caller — the read raised, see the preceding log line; the route requires \`${required}\`.`;
    case "known":
      return `${provider} resolved [${[...held].sort().join(", ")}] for ${reading.holder.label}; the route requires \`${required}\`.`;
    // A resolver that never offered a holder at all — every one written before this existed. Reads exactly
    // as it always did, which is what keeps the three sentences above meaning something when they appear.
    default:
      return `${provider} resolved [${[...held].sort().join(", ")}]; the route requires \`${required}\`.`;
  }
}

/** The gate's denial: one code, one status, whatever the reason. The reason rides in `detail`. */
function denied(
  keys: readonly string[],
  provider: string | null,
  held: ReadonlySet<string>,
  reading: HolderReading,
): PithyError {
  return new PithyError({
    code: "payments/entitlement_required",
    status: 403,
    message: "This feature requires an active subscription or purchase.",
    action: "Purchase or restore the product that grants access, then retry.",
    detail: denialDetail(keys, provider, held, reading),
  });
}

/**
 * What asking the resolver who it answered for actually produced. Four states, because collapsing any two
 * of them gives an operator the wrong diagnosis:
 *
 * - `unavailable` — the resolver offers no `holder()`. Nothing to report, and nothing went wrong.
 * - `nobody` — it answered, and the answer is that this caller acts for no holder.
 * - `known` — it answered with one.
 * - `failed` — it raised. **Not `nobody`.** A caller with no organization selected and a session store that
 *   is down look identical from the gate, and they are opposite problems: one is wiring, one is an outage.
 */
type HolderReading =
  | { readonly kind: "unavailable" }
  | { readonly kind: "nobody" }
  | { readonly kind: "known"; readonly holder: EntitlementHolder }
  | { readonly kind: "failed" };

/**
 * Require any one of `keys`. Every key is parsed at construction, so a store SKU where an entitlement
 * key belongs (`com.acme.pro.monthly`) fails on deploy rather than gating on something no projection
 * ever writes. An empty list is refused for the same reason: it reads as "nothing required" but would
 * deny every caller forever.
 */
export function requireAnyEntitlement(keys: readonly string[]): MiddlewareHandler<PithyHonoEnv> {
  if (keys.length === 0) {
    throw new InternalError({
      message: "requireAnyEntitlement() needs at least one entitlement key.",
      action: "Name the entitlements that grant access, or drop the gate if the route is not paid.",
    });
  }
  const required = keys.map((key) => EntitlementKey.parse(key));

  return async (c, next) => {
    // A gate is not an identity check: an anonymous caller is 401, so a 403 never confirms to an
    // unauthenticated stranger that the route exists and is paid.
    const auth = c.var.auth;
    if (!auth) {
      throw new UnauthorizedError({
        message: "Authentication required.",
        action: "Sign in and retry with a valid session or bearer token.",
      });
    }

    const resolver = c.var.entitlements;
    // A provider whose store is unreachable must not become an open door, so a throw is a denial.
    // The cause goes to the log, where an operator sees the difference between "unentitled" and
    // "broken" — the response cannot, without telling a client about our infrastructure.
    let held: Set<string>;
    try {
      held = grantedEntitlementKeys(await resolver.list(), new Date());
    } catch (error) {
      c.var.log.error("entitlement resolution failed", { provider: resolver.provider, cause: messageOf(error) });
      held = new Set();
    }

    // **Read after the decision, never before it.** Everything below this line is reporting: the gate has
    // already passed or denied on `held` alone, so nothing the holder says can change the outcome. A holder
    // read above the check would be a holder in reach of the check.
    if (required.some((key) => held.has(key))) {
      await next();
      return;
    }

    // Who the resolver answered for — see {@link HolderReading} for why a throw is its own state rather
    // than folding into "nobody".
    let reading: HolderReading = { kind: "unavailable" };
    if (resolver.holder) {
      try {
        const answered = await resolver.holder();
        reading = answered === undefined ? { kind: "nobody" } : { kind: "known", holder: answered };
      } catch (error) {
        // Same rule the list read follows one step up: a provider that cannot answer is a denial, never an
        // open door and never a 500. This one is strictly weaker — it costs a log line, not a decision.
        reading = { kind: "failed" };
        c.var.log.error("entitlement holder resolution failed", {
          provider: resolver.provider,
          cause: messageOf(error),
        });
      }
    }

    // A blocked attempt is a first-class audit record (`outcome: "denied"`), not only a 403. `emit()`
    // is non-fatal by contract and a no-op with no audit capability composed, so this is always safe.
    //
    // `tenant` is what makes the trail readable per customer — "which of our companies is hitting the
    // paywall" is the question, and `actorId` cannot answer it because one person acts in two tenants. It
    // is the value the **resolver reported**, never one derived here from `auth`: this middleware has no
    // idea whose action it was, and guessing would put the wrong customer on a row somebody bills from.
    // `null` is a real answer meaning *not tenant-scoped*, which is what per-person billing is.
    await c.var.emit({
      action: ENTITLEMENT_DENIED_ACTION,
      outcome: "denied",
      severity: "info",
      actorType: "user",
      actorId: auth.userId,
      sessionId: auth.sessionId,
      resourceType: "entitlement",
      resourceId: required.join("|"),
      // Only a holder we actually have. A failed read stamps null — "not tenant-scoped" is wrong but
      // inventing a tenant from a read that raised would be worse, and the log line carries the truth.
      tenant: reading.kind === "known" ? reading.holder.tenant : null,
      metadata: { provider: resolver.provider, required, held: [...held].sort() },
    });

    throw denied(required, resolver.provider, held, reading);
  };
}

/** Require one entitlement. The common case: one key gates one feature. */
export function requireEntitlement(key: string): MiddlewareHandler<PithyHonoEnv> {
  return requireAnyEntitlement([key]);
}
