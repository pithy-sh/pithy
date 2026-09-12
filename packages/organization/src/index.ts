// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add organization` wires into `pithy.config.ts`, and the
 * one `src/organization/roles.ts` imports from.
 *
 * Deliberately narrow: the capability factory and its type guard, the configuration schema, the two
 * things the scaffolded role module needs (`defineRoles` and the kit's reserved power names), the five
 * table schemas with their Kysely map, the three gates an adopter's own routes compose, and the
 * control-plane scopes a management client reads. Every other module is reached by deep path
 * (`@pithy-sh/organization/src/...`); this is the documented contract, not a barrel over the package.
 *
 * **`defineRoles` is here and nothing else in `roles/` is**, which is what makes the scaffolded module's
 * import line short and stable. The catalog's own types travel on the value it returns.
 *
 * **The store functions are deliberately absent.** `invite`, `changeRole`, `removeMember`,
 * `nominate` and the rest are the capability's own routes' internals, and an adopter reaching past the
 * gates to call them directly is an adopter writing a second door onto the rules those gates enforce. A
 * product that genuinely needs one — an operator console taking an act inside somebody's account — deep
 * imports it, which is a line a reviewer can see.
 *
 * Nothing here imports `cloudflare:workers`, so the CLI, the seed harness, and every node-project test
 * can load this module.
 */

export {
  isOrganizationCapability,
  type OrganizationCapability,
  type OrganizationOptions,
  organization,
} from "./capability";
export { OrganizationConfig, type OrganizationConfigInput } from "./config/config";
export { ActingOrganization } from "./data/actingOrganization";
export { Invitation, InvitationStatus } from "./data/invitation";
export { MAX_ROLE_LENGTH, Membership } from "./data/membership";
export { MAX_ORGANIZATION_NAME_LENGTH, MAX_SLUG_LENGTH, Organization } from "./data/organization";
export { OwnershipNomination } from "./data/ownershipNomination";
export {
  ACTING_TABLE,
  INVITATIONS_TABLE,
  MEMBERSHIPS_TABLE,
  ORGANIZATIONS_TABLE,
  type OrganizationDatabase,
  type OrganizationTables,
  OWNERSHIP_NOMINATIONS_TABLE,
  organizationDatabase,
  organizationTables,
} from "./data/tables";
export {
  type OrganizationGuardDeps,
  type OrganizationHonoEnv,
  type OrganizationVars,
  requireOrganization,
  requirePower,
} from "./http/guard";
export { ORGANIZATION_ROUTES, type OrganizationRouteDeclaration } from "./http/routes";
export {
  ORGANIZATION_ACCOUNTS_READ_SCOPE,
  ORGANIZATION_CONTROL_PLANE_SCOPES,
  ORGANIZATION_MEMBERS_READ_SCOPE,
  organizationAdminRoutes,
} from "./http/scopes";
export { requireMayAssign } from "./members/members";
export { ORGANIZATION_MIGRATION_ORDER } from "./migrations/0001_init";
export { type OwnershipRoles, requireTransferableRoles } from "./ownership/ownership";
export { defineRoles, KIT_POWERS, KitPower, type RoleCatalog, type RoleCatalogInput } from "./roles/roles";
