// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  ORGANIZATION_PURGE_KEY,
  OrganizationPurgeDueParams,
  OrganizationPurgeParams,
  organizationWorkflowRegistry,
  organizationWorkflows,
} from "./specs";

const ACME = "11111111-1111-4111-8111-111111111111";

describe("the organization purge's Workflow specs (#623)", () => {
  test("are dispatched as organization/purge and organization/purge-due", () => {
    expect(Object.keys(organizationWorkflowRegistry).sort()).toEqual(["organization/purge", "organization/purge-due"]);
    expect(ORGANIZATION_PURGE_KEY).toBe("organization/purge");
  });

  test("the daily pass shares auth's daily trigger, and a cron's empty parameters are valid for it", () => {
    expect(organizationWorkflows["purge-due"].schedule).toBe("0 2 * * *");
    expect(OrganizationPurgeDueParams.parse({})).toEqual({});
    expect(OrganizationPurgeDueParams.safeParse({ limit: 0 }).success).toBe(false);
    expect(OrganizationPurgeDueParams.safeParse({ limit: 1001 }).success).toBe(false);
  });

  test("one organization's purge is never scheduled, and names a UUID", () => {
    expect("schedule" in organizationWorkflows.purge).toBe(false);
    expect(OrganizationPurgeParams.safeParse({}).success).toBe(false);
    expect(OrganizationPurgeParams.safeParse({ organizationId: "acme" }).success).toBe(false);
    expect(OrganizationPurgeParams.parse({ organizationId: ACME })).toEqual({ organizationId: ACME });
  });
});
