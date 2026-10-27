// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { controlPlaneToolName } from "./toolName";

describe("controlPlaneToolName", () => {
  test("is <capability>_<operation>, with `.`, `:` and `/` each becoming `_`", () => {
    expect(controlPlaneToolName("support", "threads.reply")).toBe("support_threads_reply");
    expect(controlPlaneToolName("payments", "entitlements:grant")).toBe("payments_entitlements_grant");
    expect(controlPlaneToolName("audit", "events/read")).toBe("audit_events_read");
  });

  test("keeps `-` and `_`, which MCP names allow", () => {
    expect(controlPlaneToolName("auth", "users.suspend-all_now")).toBe("auth_users_suspend-all_now");
  });

  test("anything outside [a-z0-9_-] becomes `_`, so every name is one a client accepts", () => {
    expect(controlPlaneToolName("App", "Do it!")).toBe("app_do_it_");
  });
});
