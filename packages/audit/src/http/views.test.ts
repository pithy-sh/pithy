// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test } from "vitest";
import type { AuditSinkStateRow } from "../data/sinkState";
import { AuditSinks } from "../ship/sinks";
import { AuditSinksResponse } from "./responses";
import { auditSinkViews } from "./views";

const SINKS = AuditSinks.parse({
  splunk: {
    profile: "splunk-hec",
    url: "https://splunk.example.com:8088/services/collector/event?channel=abc123",
    secret: "splunk-token",
    actions: ["auth/", "controlplane/"],
    detail: true,
  },
  hook: { profile: "webhook", url: "https://hooks.example.com/audit/key-in-path", secret: "hook-token" },
});

const row = (
  sink: string,
  delivered: number | null,
  failed: number | null,
  retrying = 0,
  deadLettered = 0,
): AuditSinkStateRow => ({
  sink,
  lastDeliveredAt: delivered === null ? null : new Date(delivered),
  lastFailedAt: failed === null ? null : new Date(failed),
  retrying,
  deadLettered,
});

describe("auditSinkViews", () => {
  test("one entry per declared sink, in declaration order, each with its own row", () => {
    const statuses = auditSinkViews(SINKS, [row("hook", 5_000, null), row("splunk", 1_000, 2_000, 3, 1)]);
    expect(statuses).toEqual([
      {
        name: "splunk",
        profile: "splunk-hec",
        host: "splunk.example.com:8088",
        detail: true,
        actions: ["auth/", "controlplane/"],
        lastDeliveredAt: "1970-01-01T00:00:01.000Z",
        lastFailedAt: "1970-01-01T00:00:02.000Z",
        retrying: 3,
        deadLettered: 1,
        delivery: "failing",
      },
      {
        name: "hook",
        profile: "webhook",
        host: "hooks.example.com",
        detail: false,
        actions: null,
        lastDeliveredAt: "1970-01-01T00:00:05.000Z",
        lastFailedAt: null,
        retrying: 0,
        deadLettered: 0,
        delivery: "delivering",
      },
    ]);
  });

  test("a sink never attempted answers null times, zero counts and idle", () => {
    expect(auditSinkViews(SINKS, [])).toMatchObject([
      { name: "splunk", lastDeliveredAt: null, lastFailedAt: null, retrying: 0, deadLettered: 0, delivery: "idle" },
      { name: "hook", lastDeliveredAt: null, lastFailedAt: null, retrying: 0, deadLettered: 0, delivery: "idle" },
    ]);
  });

  test("a row for a sink no longer declared is not answered", () => {
    const statuses = auditSinkViews(SINKS, [row("removed", null, 9_000, 100, 100)]);
    expect(statuses.map((status) => status.name)).toEqual(["splunk", "hook"]);
    expect(statuses.every((status) => status.retrying === 0 && status.delivery === "idle")).toBe(true);
  });

  test("no sinks answers an empty list", () => {
    expect(auditSinkViews({}, [row("removed", 1, null)])).toEqual([]);
  });

  test("carries no token, secret name, URL path or query", () => {
    const serialized = JSON.stringify(auditSinkViews(SINKS, [row("splunk", 1, 2)]));
    for (const leaked of ["splunk-token", "hook-token", "/services", "collector", "channel", "abc123", "key-in-path"]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(auditSinkViews(SINKS, []).every((status) => !("secret" in status) && !("url" in status))).toBe(true);
  });

  test("is exactly the exported response schema's entry", () => {
    const body = { sinks: auditSinkViews(SINKS, [row("splunk", 1_000, 2_000, 3, 1)]) };
    expect(AuditSinksResponse.parse(body)).toEqual(body);
  });
});
