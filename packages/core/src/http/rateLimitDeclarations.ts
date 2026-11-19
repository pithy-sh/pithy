// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "../error/pithyError";
import type { RouteGroup } from "../openapi/document";
import { describedOperations } from "../openapi/operations";
import { routeRateLimitBinding } from "./routeRateLimit";
import type { VerificationStrategy } from "./verification";

/** The strategies that resolve a signed-in user: the only ones a `user` limit can count. */
const SIGNED_IN: ReadonlySet<VerificationStrategy> = new Set(["bearer", "session"]);

/** One rate-limit binding the composed routes need, with the policy it is written with. */
export interface RouteRateLimitBinding {
  readonly name: string;
  readonly limit: number;
  readonly period: 10 | 60;
}

/** Every binding the routes' declared limits need, once per policy, in name order. */
export function routeRateLimitBindings(groups: readonly RouteGroup[]): RouteRateLimitBinding[] {
  const byName = new Map<string, RouteRateLimitBinding>();
  for (const { spec } of describedOperations(groups)) {
    const rateLimit = spec?.rateLimit;
    if (rateLimit === undefined) continue;
    const name = routeRateLimitBinding(rateLimit);
    byName.set(name, { name, limit: rateLimit.limit, period: rateLimit.period });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Refuse a composition where a route counts users it cannot name: a `user` limit on a route whose verification
 * admits a caller who is not signed in. `createBackend` calls it at assembly, so the Worker refuses to boot.
 */
export function assertRateLimitDeclarations(groups: readonly RouteGroup[]): void {
  for (const { method, path, spec } of describedOperations(groups)) {
    if (spec?.rateLimit?.key !== "user") continue;
    const strategies: readonly VerificationStrategy[] = Array.isArray(spec.verification)
      ? spec.verification
      : [spec.verification as VerificationStrategy];
    if (strategies.every((strategy) => SIGNED_IN.has(strategy))) continue;
    const where = `${method.toUpperCase()} ${path}`;
    throw new ValidationError({
      message: `${where} limits each user, and lets in callers who are not signed in.`,
      action: 'Declare `rateLimit: { key: "ip", … }` on that route, or verify it with `bearer` or `session` alone.',
      detail: `${where} declares rateLimit key "user" with verification ${JSON.stringify(strategies)}`,
    });
  }
}
