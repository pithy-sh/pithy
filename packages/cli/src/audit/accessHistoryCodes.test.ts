// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ACCESS_ACTIONS, INVITATION_ACCEPTED_ACTION, MEMBER_ACCESS_ACTIONS } from "@pithy-sh/audit/src/accessHistory";
import { ControlPlaneAuditActions } from "@pithy-sh/core/src/controlPlane/audit/actions";
import { OrganizationAuditActions } from "@pithy-sh/organization/src/audit/actions";
import { describe, expect, test } from "vitest";

/**
 * **The access history reads the codes their registers declare (#831).**
 *
 * `@pithy-sh/audit` names `@pithy-sh/organization`'s membership codes as literals, because a capability never imports
 * another's internals. A code is stable forever once a row holds one, so a rename is already a bug — but it is a bug
 * this read would answer silently, with an access history that stopped finding every change made under the new
 * name. The CLI composes both packages, so it is where the two lists can be compared.
 */
describe("access-history codes", () => {
  test("every code the access history reads is declared by the capability that writes it", () => {
    const declared = new Set<string>([
      ...Object.values(OrganizationAuditActions),
      ...Object.values(ControlPlaneAuditActions),
    ]);
    expect(ACCESS_ACTIONS.filter((code) => !declared.has(code))).toEqual([]);
  });

  test("the code a redeemed invitation is filtered on is the one an accepted invitation writes", () => {
    expect(INVITATION_ACCEPTED_ACTION).toBe(OrganizationAuditActions.memberJoined);
  });

  test("every membership code that changes a role is read", () => {
    // The codes whose event writes, changes or ends a membership's role. A new one added to the register without
    // a place here is a change the history would never show.
    const read = new Set<string>(Object.values(MEMBER_ACCESS_ACTIONS).flat());
    expect(
      [
        OrganizationAuditActions.created,
        OrganizationAuditActions.memberJoined,
        OrganizationAuditActions.memberRoleChanged,
        OrganizationAuditActions.memberRemoved,
        OrganizationAuditActions.memberLeft,
        OrganizationAuditActions.ownershipAccepted,
        OrganizationAuditActions.adminMemberAdded,
        OrganizationAuditActions.adminMemberRemoved,
        OrganizationAuditActions.adminMemberRoleChanged,
        OrganizationAuditActions.adminOwnershipForced,
      ].filter((code) => !read.has(code)),
    ).toEqual([]);
  });
});
