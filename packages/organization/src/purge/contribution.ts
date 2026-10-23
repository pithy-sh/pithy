// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PurgeContribution } from "@pithy-sh/core/src/capability/purge";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { OrganizationNotFoundError } from "../error/errors";
import { deleteOrganization, type OrganizationDeleteSweep } from "../provision/provision";

/**
 * This capability's own contribution to an organization's purge (#623): what erasing one organization means for
 * the `pithy_organization_*` tables.
 *
 * **Every row keyed to the organization goes, except its history** — the organization, its memberships,
 * invitations, ownership offer and every session's selection of it — and, in the same transaction, the adopter's
 * own tenanted rows through `onDelete` (#570): `deleteOrganization`'s one batch, unchanged, so a hard deletion and
 * a purge erase exactly what an owner's own deletion always has. `pithy_organization_lifecycle` stays: it is the
 * record that the organization existed, was deleted and was erased.
 *
 * **Idempotent**, as the contract requires: an organization already erased is the 404 `deleteOrganization` raises,
 * and that is this step having nothing to do. The purge runs it **last**, after every other capability's step,
 * because those may still read a membership while they erase.
 */

/** The one sentence the purge records with this step. */
export const ORGANIZATION_PURGE_SUMMARY =
  "Deletes the organization, its memberships, invitations, ownership offer and every session's selection of it, with the rows `onDelete` names. Its lifecycle history stays.";

/** The D1 binding the tenancy tables live in, off a run's env — or a wiring fault naming it. */
function bindingOf(env: Record<string, unknown>, database: string): D1Database {
  const binding = env[database];
  if (typeof binding !== "object" || binding === null) {
    throw new InternalError({
      message: "The organization database is not bound, so this purge step could not run.",
      action: `Bind the ${database} D1 database to the Worker that runs the purge.`,
      detail: `organization purge contribution found no ${database} binding on the env`,
    });
  }
  return binding as D1Database;
}

/** The contribution `organization()` declares, over the D1 binding it uses and the adopter's own sweep. */
export function organizationPurgeContribution(database = "DB", sweep?: OrganizationDeleteSweep): PurgeContribution {
  return {
    subject: "organization",
    summary: ORGANIZATION_PURGE_SUMMARY,
    erase: async (context) => {
      try {
        await deleteOrganization(bindingOf(context.env, database), context.subject.id, sweep);
      } catch (error) {
        if (error instanceof OrganizationNotFoundError) return;
        throw error;
      }
    },
  };
}
