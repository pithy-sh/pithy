// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The acting-organization seam: which organization a request acts for, and what the caller's role there
 * allows.
 *
 * **Core defines it and one capability fills it.** `@pithy-sh/organization` knows memberships, roles and
 * the session's selection; `@pithy-sh/media` and `@pithy-sh/storage` need the answer and must never
 * import the capability that computes it. The split is the `AuthContext` split, for the same reason: a
 * capability that imported its tenancy from another package would fail open the day that package was
 * absent, and through this seam it fails closed instead. With no organization capability composed the
 * resolver answers `null`, every record a request writes carries a null organization, and every rule
 * that admits by organization admits nobody.
 *
 * **A resolver, not a value.** Resolving costs a D1 read — the session's selection, rejoined against a
 * live membership — and most requests never ask. So the organization capability publishes a function and
 * the first reader pays for the answer; {@link memoizeActing} makes sure no second reader pays again.
 * Reading `c.var.auth` at call time rather than at publish time is also what makes it independent of
 * composition order: a Worker that lists `organization()` ahead of `auth()` still resolves against the
 * session auth set.
 *
 * **Two facts and no more.** The organization id is what a write records and what a read is scoped to;
 * `roleAllows` is the one authorization question a capability outside tenancy may ask, so it asks it
 * without learning the role's name or the catalog's shape. A power is a string here because the catalog
 * is the adopter's and is not known when core compiles; a power nobody declared simply allows nothing.
 */

/** The organization a request acts for, and the one question a capability may ask about the caller's role. */
export interface ActingOrganization {
  /** The organization this request acts for. What a write records and what a scoped read filters on. */
  readonly organizationId: string;
  /**
   * Whether the caller's role in that organization holds a power — `media:manage`, `storage:manage`.
   * Answered from the membership row read on this request, never from a session claim.
   */
  roleAllows(power: string): boolean;
}

/** How a request learns its acting organization. `null` is a real answer: nothing is in force. */
export type ActingOrganizationResolver = () => Promise<ActingOrganization | null>;

/** The seam's default: no organization capability is composed, so nothing is ever in force. */
export const noActingOrganization: ActingOrganizationResolver = async () => null;

/**
 * Wrap a resolver so it runs at most once per request.
 *
 * The promise is kept, not the value, so concurrent readers share one read and a refusal stays a refusal:
 * a resolver that threw for an unrecognized role must not be retried by the next reader into a different
 * answer within the same request.
 */
export function memoizeActing(resolve: ActingOrganizationResolver): ActingOrganizationResolver {
  let answer: Promise<ActingOrganization | null> | undefined;
  return () => {
    answer ??= resolve();
    return answer;
  };
}
