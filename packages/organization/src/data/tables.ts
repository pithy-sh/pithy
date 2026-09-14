// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { ActingOrganization } from "./actingOrganization";
import { Invitation } from "./invitation";
import { Membership } from "./membership";
import { Organization } from "./organization";
import { OwnershipNomination } from "./ownershipNomination";

/** The tenant itself. `CamelCasePlugin` snake-cases it to `pithy_organization_organizations`. */
export const ORGANIZATIONS_TABLE = "pithyOrganizationOrganizations";
/** The join that grants access, and the authority every gate re-reads. → `pithy_organization_memberships`. */
export const MEMBERSHIPS_TABLE = "pithyOrganizationMemberships";
/** Outstanding offers of membership, bound to an address. → `pithy_organization_invitations`. */
export const INVITATIONS_TABLE = "pithyOrganizationInvitations";
/** One standing offer of ownership per account. → `pithy_organization_ownership_nominations`. */
export const OWNERSHIP_NOMINATIONS_TABLE = "pithyOrganizationOwnershipNominations";
/** Which organization a session is acting in. → `pithy_organization_acting`. */
export const ACTING_TABLE = "pithyOrganizationActing";

/** The tenancy tables map. All five are always present — none is behind a config flag. */
export function organizationTables(): Record<string, z.ZodObject> {
  return {
    [ORGANIZATIONS_TABLE]: Organization,
    [MEMBERSHIPS_TABLE]: Membership,
    [INVITATIONS_TABLE]: Invitation,
    [OWNERSHIP_NOMINATIONS_TABLE]: OwnershipNomination,
    [ACTING_TABLE]: ActingOrganization,
  };
}

/** The typed Kysely database over the tenancy tables. */
export type OrganizationTables = {
  [ORGANIZATIONS_TABLE]: typeof Organization;
  [MEMBERSHIPS_TABLE]: typeof Membership;
  [INVITATIONS_TABLE]: typeof Invitation;
  [OWNERSHIP_NOMINATIONS_TABLE]: typeof OwnershipNomination;
  [ACTING_TABLE]: typeof ActingOrganization;
};
export type OrganizationDatabase = Kysely<DatabaseSchema<OrganizationTables>>;

/** Build the tenancy database from a D1 binding, with `CamelCasePlugin` installed. */
export function organizationDatabase(d1: D1Database): OrganizationDatabase {
  return createDatabase(d1, {
    [ORGANIZATIONS_TABLE]: Organization,
    [MEMBERSHIPS_TABLE]: Membership,
    [INVITATIONS_TABLE]: Invitation,
    [OWNERSHIP_NOMINATIONS_TABLE]: OwnershipNomination,
    [ACTING_TABLE]: ActingOrganization,
  }) as unknown as OrganizationDatabase;
}
