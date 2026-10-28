// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What kind of operation a control-plane scope grants, declared by the capability that owns the scope.
 *
 * Scopes are federated and open, so a management client cannot tell from the string whether `auth:users:suspend`
 * reads, writes or does something worse. The kind is the closed vocabulary it maps its own roles onto instead: the
 * app tools' effects, with `reads` beneath them and `credentials` (mints, rotates or revokes a credential) above.
 * Ordered from least to most restrictive. Written out rather than spread from `TOOL_EFFECTS`, so a scope declaration
 * stays importable from a browser program without the route machinery; `kind.test.ts` holds the two together.
 */
export const SCOPE_KINDS = ["reads", "writes", "sends", "charges", "deletes", "credentials"] as const;

export const ScopeKind = z
  .enum(SCOPE_KINDS)
  .describe(
    "What kind of operation a scope grants: `reads`, `writes`, `sends` (mail or a message leaves the system), `charges` (money or an entitlement moves), `deletes`, or `credentials` (a credential is minted, rotated or revoked).",
  );
export type ScopeKind = z.infer<typeof ScopeKind>;

/** The kind a client assumes for a scoped route that states none: a Worker too old to say. */
export const MOST_RESTRICTIVE_SCOPE_KIND: ScopeKind = "credentials";

/** The part of an admin route a kind is read from. */
export interface ScopedRoute {
  readonly scope: string | null;
  readonly kind?: ScopeKind | undefined;
}

/**
 * The kind of a route as a client reads it: its declared kind, {@link MOST_RESTRICTIVE_SCOPE_KIND} for a scoped
 * route that declares none, and null for a route with no scope, which grants nothing to classify.
 */
export function scopeKindOf(route: ScopedRoute): ScopeKind | null {
  if (route.scope === null) return null;
  return route.kind ?? MOST_RESTRICTIVE_SCOPE_KIND;
}

/** One scope whose routes declare more than one kind. */
export interface ScopeKindConflict {
  readonly scope: string;
  /** Every kind declared for it, in the order first seen. */
  readonly kinds: readonly ScopeKind[];
}

/**
 * Every scope whose routes disagree about its kind. Holding a scope confers every route that requires it, so a
 * scope has exactly one kind, and two routes declaring different ones is a declaration to fix.
 */
export function scopeKindConflicts(routes: Iterable<ScopedRoute>): ScopeKindConflict[] {
  const kinds = new Map<string, ScopeKind[]>();
  for (const route of routes) {
    const kind = scopeKindOf(route);
    if (route.scope === null || kind === null) continue;
    const seen = kinds.get(route.scope) ?? [];
    if (!seen.includes(kind)) seen.push(kind);
    kinds.set(route.scope, seen);
  }
  return [...kinds].filter(([, seen]) => seen.length > 1).map(([scope, seen]) => ({ scope, kinds: seen }));
}
