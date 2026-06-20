import { describe, expect, test } from "vitest";
import { defineAuditActions } from "./actions";

describe("defineAuditActions", () => {
  test("returns the same constants when every code is a valid namespaced action", () => {
    const actions = defineAuditActions({
      login: "auth/login",
      tokenRefreshed: "auth/token_refreshed",
      configChanged: "admin/config_changed",
    });
    expect(actions.login).toBe("auth/login");
    expect(actions.tokenRefreshed).toBe("auth/token_refreshed");
  });

  test("throws an audit/invalid_event error naming the offending constant", () => {
    expect(() => defineAuditActions({ bad: "NotNamespaced" })).toThrowError(/bad/);
  });

  test("rejects a code missing the domain/reason slash", () => {
    expect(() => defineAuditActions({ login: "login" })).toThrow();
  });

  test("rejects an uppercase code", () => {
    expect(() => defineAuditActions({ login: "Auth/Login" })).toThrow();
  });
});
