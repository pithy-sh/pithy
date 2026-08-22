// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The control-plane scope model. Scopes are **per management operation, not per credential-holder**:
 * a credential that may read purchases cannot revoke an entitlement unless separately scoped, and
 * anything unscoped is denied.
 *
 * Scopes federate the way audit actions and migration namespaces do — a capability declares its own
 * (`payments:entitlements:grant`) without touching core, so this is an open, pattern-validated string
 * rather than a closed union. Core holds only the seam's own scopes and the matching rule.
 */

/** `resource:action`, or `resource:sub:action` — lowercase segments joined by colons. */
const SCOPE_PATTERN = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9_]*)+$/;

/**
 * One granted operation. Validated on the way into the connection row and on the way out of a token,
 * so a malformed scope is a parse failure at the boundary rather than a silent never-match — a scope
 * that reads as a grant in the row and denies at every call looks like a bug in the seam.
 */
export const ControlPlaneScope = z
  .string()
  .regex(
    SCOPE_PATTERN,
    "A control-plane scope must be lowercase colon-separated segments naming one operation (e.g. `manifest:read`, `payments:entitlements:grant`).",
  )
  .describe(
    "One management operation a connection may perform, as a colon-separated `resource:action` code. The taxonomy is federated: each capability declares its own scopes, and core holds only the seam's.",
  );
export type ControlPlaneScope = z.output<typeof ControlPlaneScope>;

/**
 * The requirement for a route that needs a **verified caller but no authorization** — today, only
 * `GET /control-plane/ping`.
 *
 * Ping is not a scope, and modeling it as one would be dishonest: granting it would change nothing
 * and withholding it would change nothing, because ping must work for a connection granted nothing at
 * all. It is the call that proves a newly registered key works *before* the key it replaces is
 * expired, and that ordering is the entire safety property of rotation. A ping that could be withheld
 * would let a connection reach a state where the replacement can never be proven — and then either the
 * old key is never expired, or it is expired anyway and nobody can get back in.
 *
 * A symbol rather than a magic string, so it is unforgeable by construction. Claims arrive over the
 * wire as JSON, and no JSON value is ever equal to this — a caller cannot present it, only a route can
 * require it.
 */
export const ANY_VERIFIED_CALLER: unique symbol = Symbol.for("pithy.controlPlane.anyVerifiedCaller");

/**
 * What a route demands of a caller: one named operation, or merely that it verified.
 *
 * `requireControlPlane` takes this rather than an optional scope on purpose. An optional argument is a
 * thing you can forget, and forgetting it on an admin route would mean shipping an unscoped one; a
 * required argument means the only way to write a route with no authorization is to say
 * {@link ANY_VERIFIED_CALLER} out loud, which is as deliberate as naming a scope.
 */
export type ControlPlaneRequirement = ControlPlaneScope | typeof ANY_VERIFIED_CALLER;

/**
 * Read this Worker's composed capability manifest — the discovery-over-configuration call.
 *
 * Annotated `: ControlPlaneScope` like every capability's scope, and not merely for symmetry: that
 * annotation is how `tooling/browser-scopes` finds a control-plane scope at all. Matching the type
 * rather than the `_SCOPE` suffix is what keeps `PLAY_SCOPE` (a Google OAuth URL) and `GLOBAL_SCOPE`
 * (an environment name) out of a gate that has nothing to say about either.
 */
export const MANIFEST_READ_SCOPE: ControlPlaneScope = "manifest:read";

/**
 * Register a new public key, expire a superseded one, and read the registration state. One scope for
 * the whole key lifecycle, granted separately at connect: an adopter who does not want a management
 * client changing keys on a schedule simply does not grant it, and then it *cannot*, whatever the
 * client intends. Better than a toggle anyone has to be trusted to honor.
 */
export const KEYS_ROTATE_SCOPE: ControlPlaneScope = "keys:rotate";

/**
 * Every grantable scope the seam's own routes use — what `pithy dashboard connect` offers by default.
 * Ping is absent because it is not grantable; see {@link ANY_VERIFIED_CALLER}.
 */
export const SEAM_SCOPES: readonly ControlPlaneScope[] = [MANIFEST_READ_SCOPE, KEYS_ROTATE_SCOPE];

/**
 * Does this call carry what the route requires?
 *
 * Both sides must agree, and they are checked against different things on purpose. `granted` is what
 * the **adopter** stored on the connection; `presented` is the single scope the **caller** put in the
 * token for this one call. A scope the adopter never granted is denied however the token is written,
 * and a token that claims a broad grant still only exercises the one operation it named.
 *
 * Matching is exact string equality. There is no prefix or wildcard rule, because
 * `payments:entitlements` must not quietly confer `payments:entitlements:revoke` — prefix semantics on
 * an authorization check is how a read grant becomes a write one without anybody deciding it should.
 */
export function scopeCovers(required: ControlPlaneRequirement, presented: string, granted: readonly string[]): boolean {
  if (required === ANY_VERIFIED_CALLER) return true;
  if (presented !== required) return false;
  return granted.includes(required);
}
