// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { AdminOrganizationsResponse, OrganizationsResponse } from "./responses";

/**
 * The response schemas are exported, so a client reads them across a version boundary: a key added to one is
 * optional, and an older Worker's answer still parses. Both halves of each such key are pinned here — an older
 * Worker omits it and the answer still parses; a current Worker sends it and the value survives the parse. That the
 * Worker sends `suspended` is pinned beside the route, in `lifecycleRoutes.workers.test.ts`.
 */

const ORGANIZATION = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Games",
  slug: "acme",
  mark: null,
  role: "owner",
  createdAt: "2026-10-23T12:00:00.000Z",
};

describe("OrganizationsResponse.suspended", () => {
  test("a Worker from before #623 sends no count, and its list still parses", () => {
    const older = { organizations: [ORGANIZATION], acting: null, chosen: false };
    const parsed = OrganizationsResponse.safeParse(older);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.suspended).toBeUndefined();
  });

  test("a current Worker's count is kept, and a count that is not one is refused", () => {
    const current = { organizations: [], acting: null, chosen: false, suspended: 2 };
    expect(OrganizationsResponse.parse(current)).toEqual(current);
    expect(OrganizationsResponse.safeParse({ ...current, suspended: -1 }).success).toBe(false);
    expect(OrganizationsResponse.safeParse({ ...current, suspended: 1.5 }).success).toBe(false);
  });

  test("the published document does not require it", () => {
    const schema = OrganizationsResponse.toJSONSchema() as { required?: string[] };
    expect(schema.required).not.toContain("suspended");
  });
});

describe("AdminOrganizationsResponse.nextCursor", () => {
  test("a Worker from before paging sends no cursor, and its tenant list still parses", () => {
    const older = { organizations: [], truncated: true };
    const parsed = AdminOrganizationsResponse.safeParse(older);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.nextCursor).toBeUndefined();
  });

  test("a current Worker's cursor is kept, and so is the null that ends the list", () => {
    const page = { organizations: [], truncated: true, nextCursor: "opaque-cursor" };
    expect(AdminOrganizationsResponse.parse(page)).toEqual(page);
    const last = { organizations: [], truncated: false, nextCursor: null };
    expect(AdminOrganizationsResponse.parse(last)).toEqual(last);
    expect(AdminOrganizationsResponse.safeParse({ ...page, nextCursor: 7 }).success).toBe(false);
  });

  test("the published document does not require it", () => {
    const schema = AdminOrganizationsResponse.toJSONSchema() as { required?: string[] };
    expect(schema.required).not.toContain("nextCursor");
  });
});
