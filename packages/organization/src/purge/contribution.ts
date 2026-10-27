// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { type ErasingPurgeContribution, exportRows } from "@pithy-sh/core/src/capability/purge";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { ActingOrganization } from "../data/actingOrganization";
import { Invitation } from "../data/invitation";
import { Membership } from "../data/membership";
import { OwnershipNomination } from "../data/ownershipNomination";
import {
  ACTING_TABLE,
  INVITATIONS_TABLE,
  MEMBERSHIPS_TABLE,
  ORGANIZATIONS_TABLE,
  OWNERSHIP_NOMINATIONS_TABLE,
  organizationDatabase,
} from "../data/tables";
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
export function organizationPurgeContribution(
  database = "DB",
  sweep?: OrganizationDeleteSweep,
): ErasingPurgeContribution {
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

/**
 * What erasing one person means for this capability (#814): every membership they hold, the acting selection each of
 * their sessions made, every standing offer of ownership made to them or by them, and every invitation addressed to
 * them — and what exporting them hands back.
 *
 * **What stays, and why.** An invitation they sent names them as its sender, and an organization's lifecycle history
 * names who acted on it; both are the organization's record, and with the account erased the id they carry names
 * nobody. An organization they were the last owner of is left without one: the erasure is the person's right, and an
 * operator gives the organization an owner again.
 *
 * Invitations are found by the account's address (`PurgeContext.address`), in `normalizeAddress`'s form — the form
 * an invitation's address is written in. **One transaction**,
 * and **idempotent**: a second run finds nothing and deletes nothing.
 */

/** The one sentence a person's purge records with this step (#814). */
export const ORGANIZATION_USER_PURGE_SUMMARY =
  "Deletes the user's membership of every organization, the organization each of their sessions acted for, every ownership offer made to or by them, and every invitation addressed to them. Invitations they sent and organizations' lifecycle history keep their id.";

/** The user contribution `organization()` declares, over the D1 binding it uses. */
export function organizationUserPurge(database = "DB"): ErasingPurgeContribution {
  const open = (env: Record<string, unknown>) => {
    const d1 = bindingOf(env, database);
    return { d1, db: organizationDatabase(d1) };
  };
  return {
    subject: "user",
    summary: ORGANIZATION_USER_PURGE_SUMMARY,
    erase: async (context) => {
      const { d1, db } = open(context.env);
      const userId = context.subject.id;
      const read = (await context.address?.()) ?? null;
      const address = read === null ? null : normalizeAddress(read);
      const theirMemberships = db.selectFrom(MEMBERSHIPS_TABLE).select("id").where("userId", "=", userId);
      const statements = [
        db
          .deleteFrom(OWNERSHIP_NOMINATIONS_TABLE)
          .where((eb) => eb.or([eb("membershipId", "in", theirMemberships), eb("nominatedByUserId", "=", userId)])),
        db.deleteFrom(ACTING_TABLE).where("userId", "=", userId),
        db.deleteFrom(MEMBERSHIPS_TABLE).where("userId", "=", userId),
        ...(address === null ? [] : [db.deleteFrom(INVITATIONS_TABLE).where("email", "=", address)]),
      ].map((query) => {
        const compiled = query.compile();
        return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
      });
      await d1.batch(statements);
    },
    export: async (context) => {
      const { db } = open(context.env);
      const userId = context.subject.id;
      const read = (await context.address?.()) ?? null;
      const address = read === null ? null : normalizeAddress(read);
      const [memberships, selections, nominations, invitations] = await Promise.all([
        db
          .selectFrom(MEMBERSHIPS_TABLE)
          .innerJoin(ORGANIZATIONS_TABLE, `${ORGANIZATIONS_TABLE}.id`, `${MEMBERSHIPS_TABLE}.organizationId`)
          .selectAll(MEMBERSHIPS_TABLE)
          .select([
            `${ORGANIZATIONS_TABLE}.name as organizationName`,
            `${ORGANIZATIONS_TABLE}.slug as organizationSlug`,
          ])
          .where(`${MEMBERSHIPS_TABLE}.userId`, "=", userId)
          .orderBy(`${MEMBERSHIPS_TABLE}.createdAt`)
          .execute(),
        db.selectFrom(ACTING_TABLE).selectAll().where("userId", "=", userId).execute(),
        db
          .selectFrom(OWNERSHIP_NOMINATIONS_TABLE)
          .selectAll()
          .where((eb) =>
            eb.or([
              eb("membershipId", "in", db.selectFrom(MEMBERSHIPS_TABLE).select("id").where("userId", "=", userId)),
              eb("nominatedByUserId", "=", userId),
            ]),
          )
          .execute(),
        address === null
          ? Promise.resolve([])
          : db.selectFrom(INVITATIONS_TABLE).selectAll().where("email", "=", address).execute(),
      ]);
      return {
        memberships: exportRows(
          memberships.map(({ organizationName, organizationSlug, ...row }) => ({
            ...Membership.parse(row),
            organizationName,
            organizationSlug,
          })),
        ),
        selections: exportRows(selections.map((row) => ActingOrganization.parse(row))),
        ownershipOffers: exportRows(nominations.map((row) => OwnershipNomination.parse(row))),
        // Without the token's digest: it is what an invitation link is checked against, and an export is never one.
        invitations: exportRows(
          invitations.map((row) => {
            const { tokenDigest: _digest, ...invitation } = Invitation.parse(row);
            return invitation;
          }),
        ),
      };
    },
  };
}
