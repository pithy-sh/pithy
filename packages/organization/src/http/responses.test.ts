// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { OrganizationsResponse } from "./responses";

/**
 * The response schemas are exported, so a client reads them across a version boundary: a key added to one is
 * optional, and an older Worker's answer still parses. Both halves of `suspended` (#623) are pinned here — an older
 * Worker omits it and the list still parses; a current Worker sends it and the count survives the parse. That the
 * Worker sends it is pinned beside the route, in `lifecycleRoutes.workers.test.ts`.
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
