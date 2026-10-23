// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { Organization } from "../data/organization";

/**
 * What an organization's four lifecycle columns mean, decided once (#623).
 *
 * Every door that lets a member act — the acting resolver, the chooser's list, the selection write — reads the
 * state through {@link organizationStanding}. Enforcement written twice is enforcement that disagrees, and the
 * first disagreement would be a suspension one door honors and another does not. The rule is the one
 * `@pithy-sh/auth`'s `accountStanding` holds for a person, on purpose: an operator reading both should not have
 * to learn two.
 */

/**
 * The four columns, decoded off whatever carries them. Unknown keys are dropped, and a key that is absent — a
 * row read before `0003_organization_lifecycle` — reads as null.
 */
export const OrganizationLifecycleColumns = Organization.pick({
  suspendedAt: true,
  suspendedUntil: true,
  deletedAt: true,
  purgeAfter: true,
}).describe("An organization's lifecycle columns, as `pithy_organization_organizations` stores them.");
export type OrganizationLifecycleColumns = z.output<typeof OrganizationLifecycleColumns>;

/** Where an organization stands, at one instant. */
export type OrganizationStanding =
  | { readonly state: "active" }
  | { readonly state: "suspended"; readonly until: Date | null }
  | { readonly state: "deleted"; readonly purgeAfter: Date | null };

/**
 * Where an organization stands at `now`.
 *
 * **Deleted outranks suspended.** An organization deleted while it was suspended is deleted: the suspension's
 * end passing must not reopen it.
 *
 * **A suspension past its `suspendedUntil` is not a suspension**, and no write expires it. The end is exclusive
 * — at the instant it names, the organization is active again. That is what lets a timed suspension end on time
 * with nothing scheduled to end it.
 *
 * **A deletion past its `purgeAfter` is still a deletion.** Only the purge ends that state, by erasing it.
 */
export function organizationStanding(
  columns: Partial<Record<keyof OrganizationLifecycleColumns, Date | null | undefined>>,
  now: Date,
): OrganizationStanding {
  if (columns.deletedAt) return { state: "deleted", purgeAfter: columns.purgeAfter ?? null };
  if (columns.suspendedAt) {
    const until = columns.suspendedUntil ?? null;
    if (until === null || until.getTime() > now.getTime()) return { state: "suspended", until };
  }
  return { state: "active" };
}
