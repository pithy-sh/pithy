// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ActingOrganization } from "@pithy-sh/core/src/access/acting";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SupportStaffConfig } from "../config/config";

/**
 * **Who of the app's own signed-in users works the inbox** (#816) — `support({ staff })`.
 *
 * Asked of core's acting-organization seam, which `@pithy-sh/organization` fills from a membership row
 * read on this request; never imported, so without organization nobody is staff and every staff route
 * refuses. The catalog is read by shape at compose, the way `artifacts` reads it, so support depends on
 * no tenancy package.
 */

/** The catalog support reads off a composed organization capability. Everything else about it is ignored. */
interface StaffCatalog {
  readonly powers: readonly string[];
  readonly roles: readonly string[];
  readonly assignableRoles: readonly string[];
  roleAllows(role: string, power: string): boolean;
}

/** A composed capability's role catalog, read by shape, or undefined when it carries none. */
function catalogOf(capability: Capability): StaffCatalog | undefined {
  const catalog = (capability as { organizationRoles?: Partial<StaffCatalog> }).organizationRoles;
  if (
    !catalog ||
    !Array.isArray(catalog.powers) ||
    !Array.isArray(catalog.roles) ||
    !Array.isArray(catalog.assignableRoles) ||
    typeof catalog.roleAllows !== "function"
  ) {
    return undefined;
  }
  return catalog as StaffCatalog;
}

/**
 * The role a composed ownership transfer confers, read by shape, or undefined where there is no transfer.
 *
 * Unassignable, always — organization refuses a transfer onto an assignable role — and still self-served:
 * anybody may found an organization, every new organization starts with no holder, and with no holder an
 * administrator may nominate themselves and accept. So an unassignable role is out of an organization's
 * own reach only when it is not this one.
 */
function ownershipRoleOf(capability: Capability): string | undefined {
  const confers = (capability as { organizationOwnership?: { confers?: unknown } }).organizationOwnership?.confers;
  return typeof confers === "string" ? confers : undefined;
}

/** Refuse a staff composition at boot, naming what is wrong and what to change. */
function refuse(message: string, action: string, detail: string): never {
  throw new InternalError({ message, action, detail });
}

/**
 * Refuse, at compose, a staff block no request could be served by safely.
 *
 * Four refusals. **No organization**: a power is held in an organization, so with none composed nobody
 * could ever be staff and the block is a mistake rather than a policy. **A power the catalog does not
 * declare, or no role holds**: the same, by a typo. **A power on an assignable role**: a role is the
 * catalog's and not one organization's, and an organization's own administrator may give any assignable
 * role to their own members — so the power would make every customer's administrator able to read every
 * other customer's support mail. **A power on the role ownership transfer confers**: unassignable, and
 * still one any signed-in user can take — found an organization, nominate yourself, accept — so it opens
 * the same inbox to the same people. On any other unassignable role it is conferred through the control
 * plane alone, by an operator.
 */
export function assertStaffComposition(
  staff: SupportStaffConfig | undefined,
  capabilities: readonly Capability[],
): void {
  if (!staff) return;
  const tenancy = capabilities.find((candidate) => candidate.name === "organization");
  const catalog = tenancy ? catalogOf(tenancy) : undefined;
  if (!catalog) {
    refuse(
      "support() names staff powers, and organization is not composed.",
      "Compose organization() with a role catalog that declares them, or remove `staff` from support().",
      "a staff power is held in an organization; with none composed nobody could ever hold one",
    );
  }
  const ownership = tenancy ? ownershipRoleOf(tenancy) : undefined;
  for (const power of [staff.readPower, staff.assignPower]) {
    if (!catalog.powers.includes(power)) {
      refuse(
        `support() names staff power \`${power}\`, which your role catalog does not declare.`,
        "Declare it in defineRoles({ powers }) and give it to an unassignable role your staff hold, other than the one ownership transfer confers.",
        `declared powers: ${catalog.powers.join(", ")}`,
      );
    }
    const holders = catalog.roles.filter((role) => catalog.roleAllows(role, power));
    if (holders.length === 0) {
      refuse(
        `No role in your catalog holds support's staff power \`${power}\`.`,
        "Give it to an unassignable role your staff hold, other than the one ownership transfer confers.",
        `power ${power} is declared and held by no role`,
      );
    }
    const handable = holders.filter((role) => catalog.assignableRoles.includes(role));
    if (handable.length > 0) {
      refuse(
        `Support's staff power \`${power}\` is on a role an organization may hand out: ${handable.join(", ")}.`,
        "Move it to a role listed in defineRoles({ unassignable }) that ownership transfer does not confer, so only an operator can confer it.",
        `an organization administrator may assign ${handable.join(", ")} to their own members, which would open every customer's support mail to them`,
      );
    }
    if (ownership !== undefined && holders.includes(ownership)) {
      refuse(
        `Support's staff power \`${power}\` is on \`${ownership}\`, the role ownership transfer confers, which an organization's founder may take alone.`,
        "Move it to a role listed in defineRoles({ unassignable }) that ownership transfer does not confer, so only an operator can confer it.",
        `anybody may found an organization and nominate themselves as its ${ownership}, which would open every customer's support mail to them`,
      );
    }
  }
}

/** Whether the organization this request acts for gives the caller one of support's staff powers. */
export function staffMay(
  acting: ActingOrganization | null,
  staff: SupportStaffConfig | undefined,
  power: keyof SupportStaffConfig,
): boolean {
  return acting !== null && staff !== undefined && acting.roleAllows(staff[power]);
}
