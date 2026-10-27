// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { type CapabilityHealth, defineCapabilityHealth } from "@pithy-sh/core/src/controlPlane/discovery/health";
import type { Context } from "hono";
import type { AuditSinkStateRow } from "../data/sinkState";
import type { AuditDatabase } from "../data/tables";
import { AUDIT_TRAIL_READ_SCOPE } from "../http/guards";
import type { AuditSinks } from "./sinks";
import { readSinkStates } from "./state";

/**
 * **Shipping's health, on audit's manifest entry (#824)** — whether the trail is reaching its sinks.
 *
 * Three keys, all behind `audit:events:read`, the scope the listing already requires: a backlog, a dead-letter
 * count, and a state. Each is read off `pithy_audit_sinks` by primary key, one row per declared sink, so the bound
 * is the config's sink count and never the trail's size. Declared only when a sink is: a Worker that ships nothing
 * has nothing to report and reports nothing.
 */

/** Events waiting on a retry, across every sink. */
export const AUDIT_SHIP_BACKLOG = "auditShipBacklog";

/** Events given up on, across every sink: their last retry failed and they went to the dead-letter queue. */
export const AUDIT_SHIP_DEAD_LETTERED = "auditShipDeadLettered";

/** How delivery stands, across every sink. */
export const AUDIT_SHIP_DELIVERY = "auditShipDelivery";

/**
 * The values {@link AUDIT_SHIP_DELIVERY} takes. `failing` when any sink's last attempt failed; `delivering` when
 * every sink that has been attempted last took a delivery; `idle` when no sink has been attempted yet.
 */
export const SHIP_DELIVERY_STATES = ["delivering", "failing", "idle"] as const;
export type ShipDeliveryState = (typeof SHIP_DELIVERY_STATES)[number];

/** How delivery stands, from the declared sinks' rows. */
export function shipDelivery(states: readonly AuditSinkStateRow[]): ShipDeliveryState {
  const attempted = states.filter((state) => state.lastDeliveredAt !== null || state.lastFailedAt !== null);
  if (attempted.length === 0) return "idle";
  const failing = attempted.some(
    (state) =>
      state.lastFailedAt !== null && (state.lastDeliveredAt === null || state.lastFailedAt > state.lastDeliveredAt),
  );
  return failing ? "failing" : "delivering";
}

/** Declare shipping's health keys over the declared sinks. */
export function shipHealth(sinks: AuditSinks, database: (c: Context<PithyHonoEnv>) => AuditDatabase): CapabilityHealth {
  const names = Object.keys(sinks);
  return defineCapabilityHealth({
    keys: [
      {
        key: AUDIT_SHIP_BACKLOG,
        kind: "count",
        states: null,
        scope: AUDIT_TRAIL_READ_SCOPE,
        // A primary-key lookup per declared sink on `pithy_audit_sinks`. The bound is the config, not the trail.
        cost: "indexed",
        nominal: { atMost: 0 },
        summary: "Audit events waiting on a retry to a sink that refused or could not be reached.",
      },
      {
        key: AUDIT_SHIP_DEAD_LETTERED,
        kind: "count",
        states: null,
        scope: AUDIT_TRAIL_READ_SCOPE,
        cost: "indexed",
        nominal: { atMost: 0 },
        summary: "Audit events a sink never took: their retries ran out and they went to the dead-letter queue.",
      },
      {
        key: AUDIT_SHIP_DELIVERY,
        kind: "state",
        states: [...SHIP_DELIVERY_STATES],
        scope: AUDIT_TRAIL_READ_SCOPE,
        cost: "indexed",
        nominal: ["delivering", "idle"],
        summary: "Whether every sink took its last delivery, any sink is failing, or nothing has been shipped yet.",
      },
    ],
    read: async (c) => {
      const states = await readSinkStates(database(c), names);
      return {
        [AUDIT_SHIP_BACKLOG]: states.reduce((sum, state) => sum + state.retrying, 0),
        [AUDIT_SHIP_DEAD_LETTERED]: states.reduce((sum, state) => sum + state.deadLettered, 0),
        [AUDIT_SHIP_DELIVERY]: shipDelivery(states),
      };
    },
  });
}
