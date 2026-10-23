// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  AdminAddMember,
  AdminInvitationsQuery,
  AdminReason,
  AdminUpdateOrganization,
  CreateOrganization,
  createOrganizationBody,
  OperatorReason,
} from "./schemas";

/**
 * The one thing about the request schemas that is not obvious from reading them.
 *
 * {@link createOrganizationBody} narrows a **module-level const** for a project that derives its short
 * names. If that narrowing were in place rather than a new schema, one composed capability would decide
 * for every other one in the isolate — and the failure would be a project that never set `slugs`
 * refusing every `slug` its own clients send, on the day an unrelated Worker in the same bundle turned
 * derivation on. It is a property of the Zod version rather than of this file, which is exactly why it
 * is pinned here instead of assumed.
 */
describe("createOrganizationBody", () => {
  test("narrowing for one project leaves the shared schema alone", () => {
    const derived = createOrganizationBody("derived");
    expect(derived.safeParse({ name: "Acme", slug: "acme" }).success).toBe(false);
    expect(derived.safeParse({ name: "Acme" }).success).toBe(true);

    expect(createOrganizationBody("chosen").safeParse({ name: "Acme", slug: "acme" }).success).toBe(true);
    expect(CreateOrganization.safeParse({ name: "Acme", slug: "acme" }).success).toBe(true);
  });

  test("the refusal names the field, so a client knows which one to drop", () => {
    const refused = createOrganizationBody("derived").safeParse({ name: "Acme", slug: "acme" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["slug"]);
  });

  test("either way the name is still required and still bounded", () => {
    for (const slugs of ["chosen", "derived"] as const) {
      const body = createOrganizationBody(slugs);
      expect(body.safeParse({}).success, slugs).toBe(false);
      expect(body.safeParse({ name: "" }).success, slugs).toBe(false);
      expect(body.safeParse({ name: "a".repeat(129) }).success, slugs).toBe(false);
    }
  });
});

describe("OperatorReason", () => {
  test("is required, trimmed and bounded", () => {
    expect(OperatorReason.safeParse("  Ticket 4411.  ").data).toBe("Ticket 4411.");
    expect(OperatorReason.safeParse("").success).toBe(false);
    expect(OperatorReason.safeParse("   ").success).toBe(false);
    expect(OperatorReason.safeParse("r".repeat(500)).success).toBe(true);
    expect(OperatorReason.safeParse("r".repeat(501)).success).toBe(false);
  });

  test("refuses an address, so the trail is never asked to drop the operator's reason", () => {
    const refused = OperatorReason.safeParse("Invitation went to ada@exmaple.com by mistake");
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toContain("no address");
  });

  test("every operator body and the invitation query require one", () => {
    expect(AdminReason.safeParse({}).success).toBe(false);
    expect(AdminAddMember.safeParse({ userId: "user-ada", role: "member" }).success).toBe(false);
    expect(AdminUpdateOrganization.safeParse({ name: "Acme" }).success).toBe(false);
    expect(AdminInvitationsQuery.safeParse({}).success).toBe(false);
    expect(AdminInvitationsQuery.safeParse({ reason: "Fixing an invite.", limit: "5" }).data).toEqual({
      reason: "Fixing an invite.",
      limit: 5,
    });
  });
});

describe("AdminUpdateOrganization", () => {
  test("needs a field to change beside the reason", () => {
    expect(AdminUpdateOrganization.safeParse({ reason: "Rebrand." }).success).toBe(false);
    expect(AdminUpdateOrganization.safeParse({ reason: "Rebrand.", name: "Globex" }).success).toBe(true);
  });

  test("a null seat limit lifts it, and a seat limit is a whole number from one", () => {
    expect(AdminUpdateOrganization.safeParse({ reason: "r", seatLimit: null }).data?.seatLimit).toBeNull();
    for (const seatLimit of [0, -1, 2.5]) {
      expect(AdminUpdateOrganization.safeParse({ reason: "r", seatLimit }).success, String(seatLimit)).toBe(false);
    }
  });

  test("an unknown field is refused rather than quietly dropped", () => {
    expect(AdminUpdateOrganization.safeParse({ reason: "r", name: "Globex", logo: null }).success).toBe(false);
  });
});
