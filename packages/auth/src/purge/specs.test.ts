// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { AUTH_PURGE_KEY, AuthPurgeDueParams, AuthPurgeParams, authWorkflowRegistry, authWorkflows } from "./specs";

describe("the purge's Workflow specs (#622)", () => {
  test("are dispatched as auth/purge and auth/purge-due", () => {
    expect(Object.keys(authWorkflowRegistry).sort()).toEqual(["auth/purge", "auth/purge-due"]);
    expect(AUTH_PURGE_KEY).toBe("auth/purge");
  });

  test("the daily pass runs once a day, and a cron's empty parameters are valid for it", () => {
    expect(authWorkflows["purge-due"].schedule).toBe("0 2 * * *");
    expect(AuthPurgeDueParams.parse({})).toEqual({});
    expect(AuthPurgeDueParams.safeParse({ limit: 0 }).success).toBe(false);
    expect(AuthPurgeDueParams.safeParse({ limit: 1001 }).success).toBe(false);
  });

  test("one account's purge is never scheduled, and names its account", () => {
    expect("schedule" in authWorkflows.purge).toBe(false);
    expect(AuthPurgeParams.safeParse({}).success).toBe(false);
    expect(AuthPurgeParams.parse({ userId: "u1", notify: false })).toEqual({ userId: "u1", notify: false });
  });
});
