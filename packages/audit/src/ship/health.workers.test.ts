// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { Context } from "hono";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { auditDatabase } from "../data/tables";
import { AUDIT_TRAIL_READ_SCOPE } from "../http/guards";
import { audit_0006_sinks } from "../migrations/0006_sinks";
import { AUDIT_SHIP_BACKLOG, AUDIT_SHIP_DEAD_LETTERED, AUDIT_SHIP_DELIVERY, shipHealth } from "./health";
import { AuditSinks } from "./sinks";
import { recordSinkOutcome } from "./state";

/** Shipping's health keys (#824), read off a real `pithy_audit_sinks`. */

const db = () => auditDatabase(env.DB);

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_sinks").run();
  await audit_0006_sinks.up(db() as unknown as Kysely<unknown>);
});

const SINKS = AuditSinks.parse({
  splunk: { profile: "splunk-hec", url: "https://splunk.example.com/services/collector/event", secret: "splunk-token" },
  hook: { profile: "webhook", url: "https://hooks.example.com/audit", secret: "hook-token" },
});

// The read never touches the context but to hand it to the database seam, which ignores it here.
const c = {} as Context<PithyHonoEnv>;

describe("shipHealth", () => {
  test("declares the three keys, each behind audit:events:read", () => {
    const health = shipHealth(SINKS, () => db());
    expect(health.keys.map((key) => [key.key, key.scope])).toEqual([
      [AUDIT_SHIP_BACKLOG, AUDIT_TRAIL_READ_SCOPE],
      [AUDIT_SHIP_DEAD_LETTERED, AUDIT_TRAIL_READ_SCOPE],
      [AUDIT_SHIP_DELIVERY, AUDIT_TRAIL_READ_SCOPE],
    ]);
    expect([AUDIT_SHIP_BACKLOG, AUDIT_SHIP_DEAD_LETTERED, AUDIT_SHIP_DELIVERY]).toEqual([
      "auditShipBacklog",
      "auditShipDeadLettered",
      "auditShipDelivery",
    ]);
    expect(AUDIT_TRAIL_READ_SCOPE).toBe("audit:events:read");
  });

  test("idle with zero counts before any sink has been attempted", async () => {
    expect(await shipHealth(SINKS, () => db()).read(c)).toEqual({
      [AUDIT_SHIP_BACKLOG]: 0,
      [AUDIT_SHIP_DEAD_LETTERED]: 0,
      [AUDIT_SHIP_DELIVERY]: "idle",
    });
  });

  test("sums the backlog and the dead letters across the declared sinks only", async () => {
    await recordSinkOutcome(db(), "splunk", {
      delivered: false,
      at: new Date(2000),
      retryingDelta: 3,
      deadLettered: 1,
    });
    await recordSinkOutcome(db(), "hook", { delivered: true, at: new Date(1000), retryingDelta: 2, deadLettered: 4 });
    // A sink renamed away from the config leaves its row behind, and nothing reads it.
    await recordSinkOutcome(db(), "removed", {
      delivered: false,
      at: new Date(9000),
      retryingDelta: 100,
      deadLettered: 100,
    });

    expect(await shipHealth(SINKS, () => db()).read(c)).toEqual({
      [AUDIT_SHIP_BACKLOG]: 5,
      [AUDIT_SHIP_DEAD_LETTERED]: 5,
      [AUDIT_SHIP_DELIVERY]: "failing",
    });
  });

  test("delivering once every declared sink last took a delivery, whatever an undeclared one did", async () => {
    await recordSinkOutcome(db(), "splunk", { delivered: true, at: new Date(1000), retryingDelta: 0, deadLettered: 0 });
    await recordSinkOutcome(db(), "removed", {
      delivered: false,
      at: new Date(9000),
      retryingDelta: 1,
      deadLettered: 0,
    });
    expect(await shipHealth(SINKS, () => db()).read(c)).toEqual({
      [AUDIT_SHIP_BACKLOG]: 0,
      [AUDIT_SHIP_DEAD_LETTERED]: 0,
      [AUDIT_SHIP_DELIVERY]: "delivering",
    });
  });
});
