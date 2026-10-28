// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  AUDIT_RETENTION_FLOOR_DAYS,
  auditWindowDays,
  durationDays,
  EffectiveRetention,
  inactivityDays,
  parseRetentionPolicy,
  prunesAudit,
  purgeWindowDays,
  resolveRetention,
} from "./policy";

const composition = {
  purgeWindows: [
    { subject: "user", days: 30 },
    { subject: "organization", days: 30 },
  ],
  lifecycleActions: ["auth/admin_user_purged", "organization/purged"],
} as const;

describe("durationDays", () => {
  test("reads days, weeks, thirty-day months and 365-day years", () => {
    expect(durationDays(45)).toBe(45);
    expect(durationDays("90d")).toBe(90);
    expect(durationDays("2w")).toBe(14);
    expect(durationDays("18m")).toBe(540);
    expect(durationDays("3y")).toBe(1095);
  });
});

describe("parseRetentionPolicy", () => {
  test("an absent block is the empty policy", () => {
    expect(parseRetentionPolicy(undefined)).toEqual({});
  });

  test("refuses a duration with no unit, a zero, and a key it does not know", () => {
    expect(() => parseRetentionPolicy({ classAges: { pii: "3" } })).toThrow(/retention block/);
    expect(() => parseRetentionPolicy({ purgeWindows: { user: 0 } })).toThrow(/retention block/);
    expect(() => parseRetentionPolicy({ audit: { keep: "1y" } })).toThrow(/retention block/);
    expect(() => parseRetentionPolicy({ shorten: true })).toThrow(/retention block/);
  });
});

describe("resolveRetention", () => {
  test("an empty policy keeps each capability's window and the trail forever", () => {
    const effective = resolveRetention({}, composition);
    expect(EffectiveRetention.parse(effective)).toEqual(effective);
    expect(effective.purgeWindows).toEqual([
      { subject: "user", days: 30, source: "capability" },
      { subject: "organization", days: 30, source: "capability" },
    ]);
    expect(effective.audit.defaultDays).toBeNull();
    expect(effective.audit.rules).toEqual([]);
    expect(prunesAudit(effective)).toBe(false);
    expect(auditWindowDays(effective, "support/thread_opened")).toBeNull();
  });

  test("a stated window replaces the capability's", () => {
    const effective = resolveRetention({ purgeWindows: { user: "90d" } }, composition);
    expect(purgeWindowDays(effective, "user")).toBe(90);
    expect(effective.purgeWindows[0]?.source).toBe("policy");
    expect(purgeWindowDays(effective, "organization")).toBe(30);
  });

  test("refuses a rule under the floor that covers controlplane/*", () => {
    expect(() => resolveRetention({ audit: { prefixes: { "controlplane/": "90d" } } }, composition)).toThrow(
      /under the kit's floor of 365 for controlplane\//,
    );
    expect(() => resolveRetention({ audit: { prefixes: { "controlplane/call_": 30 } } }, composition)).toThrow(/floor/);
  });

  test("refuses a rule under the floor that covers a composed lifecycle action", () => {
    expect(() => resolveRetention({ audit: { prefixes: { "auth/": "6m" } } }, composition)).toThrow(
      /auth\/admin_user_purged/,
    );
  });

  test("accepts a short rule that leaves every floored action out", () => {
    const effective = resolveRetention({ audit: { prefixes: { "auth/signin": "30d" } } }, composition);
    expect(auditWindowDays(effective, "auth/signin")).toBe(30);
    expect(auditWindowDays(effective, "auth/admin_user_purged")).toBeNull();
  });

  test("holds every floored action at the floor under a short default", () => {
    const effective = resolveRetention({ audit: { default: "90d" } }, composition);
    expect(auditWindowDays(effective, "support/thread_opened")).toBe(90);
    expect(auditWindowDays(effective, "controlplane/call_allowed")).toBe(AUDIT_RETENTION_FLOOR_DAYS);
    expect(auditWindowDays(effective, "organization/purged")).toBe(AUDIT_RETENTION_FLOOR_DAYS);
    expect(effective.audit.rules.filter((rule) => rule.source === "floor").map((rule) => rule.prefix)).toEqual([
      "auth/admin_user_purged",
      "organization/purged",
      "controlplane/",
    ]);
    expect(prunesAudit(effective)).toBe(true);
  });

  test("the longest matching prefix decides", () => {
    const effective = resolveRetention(
      { audit: { default: "forever", prefixes: { "support/": "2y", "support/thread_": "1y" } } },
      composition,
    );
    expect(auditWindowDays(effective, "support/thread_opened")).toBe(365);
    expect(auditWindowDays(effective, "support/reply")).toBe(730);
    expect(auditWindowDays(effective, "media/uploaded")).toBeNull();
  });

  test("class ages resolve strictest first, and the strictest held decides inactivity", () => {
    const effective = resolveRetention({ classAges: { pii: "3y", phi: "1y" } }, composition);
    expect(effective.classAges).toEqual([
      { class: "phi", days: 365 },
      { class: "pii", days: 1095 },
    ]);
    expect(inactivityDays(effective, ["pii"])).toBe(1095);
    expect(inactivityDays(effective, ["pii", "phi"])).toBe(365);
    expect(inactivityDays(effective, ["secret"])).toBeNull();
  });
});
