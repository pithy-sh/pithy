// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { OrganizationSuspendedError } from "../error/errors";
import { ORGANIZATION_SUSPENDED, organizationRefusal } from "./lifecycle";

describe("organizationRefusal", () => {
  test("names the code the Worker refuses a suspended organization with", () => {
    expect(new OrganizationSuspendedError().payload.code).toBe(ORGANIZATION_SUSPENDED);
    expect(organizationRefusal(ORGANIZATION_SUSPENDED)).toBe("suspended");
  });

  test("anything else is no lifecycle refusal, a missing organization included", () => {
    for (const code of [
      "organization/not_found",
      "organization/forbidden",
      "auth/account_suspended",
      null,
      undefined,
    ]) {
      expect(organizationRefusal(code), String(code)).toBeNull();
    }
  });
});
