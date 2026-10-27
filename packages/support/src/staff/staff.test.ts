// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ActingOrganization } from "@pithy-sh/core/src/access/acting";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { assertStaffComposition, staffMay } from "./staff";

/**
 * The staff rule: a signed-in user works the inbox only through a power the adopter names, held in the
 * organization the request acts for — and only ever on a role no organization can hand itself: neither an
 * assignable one nor the one ownership transfer confers.
 */

const STAFF = { readPower: "support:read", assignPower: "support:assign" };

/** A tenancy capability, by the shape support reads it: a name, and the catalog in force. */
function tenancy(catalog: {
  powers: string[];
  roles: Record<string, string[]>;
  unassignable?: string[];
  ownership?: { confers: string; demotesTo: string };
}): Capability {
  const roles = Object.keys(catalog.roles);
  return {
    name: "organization",
    requiredBindings: [],
    organizationOwnership: catalog.ownership,
    organizationRoles: {
      powers: catalog.powers,
      roles,
      assignableRoles: roles.filter((role) => !(catalog.unassignable ?? []).includes(role)),
      roleAllows: (role: string, power: string) => catalog.roles[role]?.includes(power) ?? false,
    },
  } as unknown as Capability;
}

const GOOD = tenancy({
  powers: ["organization:read", "support:read", "support:assign"],
  roles: {
    member: ["organization:read"],
    admin: ["organization:read"],
    staff: ["organization:read", "support:read", "support:assign"],
  },
  unassignable: ["staff"],
});

describe("assertStaffComposition", () => {
  test("no staff block asks nothing of the composition, organization or not", () => {
    expect(() => assertStaffComposition(undefined, [])).not.toThrow();
    expect(() => assertStaffComposition(undefined, [GOOD])).not.toThrow();
  });

  test("a catalog that declares both powers, on unassignable roles only, is accepted", () => {
    expect(() => assertStaffComposition(STAFF, [GOOD])).not.toThrow();
  });

  test("a staff block without organization is refused, since no power could ever be held", () => {
    expect(() => assertStaffComposition(STAFF, [])).toThrow(/organization is not composed/);
  });

  test("a power the catalog does not declare is refused, naming it", () => {
    const catalog = tenancy({
      powers: ["organization:read", "support:read"],
      roles: { staff: ["support:read"] },
      unassignable: ["staff"],
    });
    expect(() => assertStaffComposition(STAFF, [catalog])).toThrow(/support:assign/);
  });

  test("a power on a role somebody may hand out is refused, naming the role", () => {
    // An organization's own admin could give `admin` to themselves in their own account, and then read
    // every other customer's mail. Only an operator may confer what reaches the whole inbox.
    const catalog = tenancy({
      powers: ["organization:read", "support:read", "support:assign"],
      roles: {
        admin: ["organization:read", "support:read"],
        staff: ["support:read", "support:assign"],
      },
      unassignable: ["staff"],
    });
    expect(() => assertStaffComposition(STAFF, [catalog])).toThrow(/admin/);
  });

  test("a power on the role ownership transfer confers is refused, because a founder may take that role alone", () => {
    // Anybody may found an organization, and an organization with no holder lets its administrator
    // nominate themselves and accept. Unassignable or not, the transfer's role is self-served.
    const catalog = tenancy({
      powers: ["organization:read", "support:read", "support:assign"],
      roles: {
        member: ["organization:read"],
        admin: ["organization:read"],
        owner: ["organization:read", "support:read", "support:assign"],
      },
      unassignable: ["owner"],
      ownership: { confers: "owner", demotesTo: "admin" },
    });
    expect(() => assertStaffComposition(STAFF, [catalog])).toThrow(/owner/);
  });

  test("an ownership transfer that confers some other role leaves an unassignable staff role accepted", () => {
    const catalog = tenancy({
      powers: ["organization:read", "support:read", "support:assign"],
      roles: {
        admin: ["organization:read"],
        owner: ["organization:read"],
        staff: ["organization:read", "support:read", "support:assign"],
      },
      unassignable: ["owner", "staff"],
      ownership: { confers: "owner", demotesTo: "admin" },
    });
    expect(() => assertStaffComposition(STAFF, [catalog])).not.toThrow();
  });

  test("a power no role holds is refused, because no signed-in user could ever use it", () => {
    const catalog = tenancy({
      powers: ["organization:read", "support:read", "support:assign"],
      roles: { staff: ["support:read"] },
      unassignable: ["staff"],
    });
    expect(() => assertStaffComposition(STAFF, [catalog])).toThrow(/support:assign/);
  });
});

/** An acting organization whose role holds exactly the powers named. */
function acting(...powers: string[]): ActingOrganization {
  return { organizationId: "org-staff", roleAllows: (power) => powers.includes(power) };
}

describe("staffMay", () => {
  test("admits a caller whose acting role holds the power", () => {
    expect(staffMay(acting("support:assign"), STAFF, "assignPower")).toBe(true);
  });

  test("refuses a caller acting for no organization, a role without the power, and a Worker with no staff", () => {
    expect(staffMay(null, STAFF, "assignPower")).toBe(false);
    expect(staffMay(acting("support:read"), STAFF, "assignPower")).toBe(false);
    expect(staffMay(acting("support:assign"), undefined, "assignPower")).toBe(false);
  });

  test("the read power admits presence and not assignment, and the other way about", () => {
    expect(staffMay(acting("support:read"), STAFF, "readPower")).toBe(true);
    expect(staffMay(acting("support:assign"), STAFF, "readPower")).toBe(false);
  });
});
