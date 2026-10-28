// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { forgetRetention, recordRetention } from "@pithy-sh/core/src/retention/composed";
import { resolveRetention } from "@pithy-sh/core/src/retention/policy";
import { afterEach, describe, expect, test } from "vitest";
import { organizationPurgeWindowDays } from "./transitions";

describe("organizationPurgeWindowDays", () => {
  afterEach(() => forgetRetention());

  test("with no block recorded, the capability's own window", () => {
    expect(organizationPurgeWindowDays(30)).toBe(30);
  });

  test("the block's organization window replaces the capability's own", () => {
    recordRetention(
      resolveRetention(
        { purgeWindows: { organization: "12w" } },
        { purgeWindows: [{ subject: "organization", days: 30 }], lifecycleActions: [] },
      ),
    );
    expect(organizationPurgeWindowDays(30)).toBe(84);
  });

  test("a block that names only the user window leaves the organization's own", () => {
    recordRetention(
      resolveRetention(
        { purgeWindows: { user: "90d" } },
        { purgeWindows: [{ subject: "organization", days: 30 }], lifecycleActions: [] },
      ),
    );
    expect(organizationPurgeWindowDays(30)).toBe(30);
  });
});
