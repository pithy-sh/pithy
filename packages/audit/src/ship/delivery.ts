// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { AuditSinkStateRow } from "../data/sinkState";

/**
 * The values a delivery state takes: per sink on the sinks read, and across every sink on the manifest's
 * `auditShipDelivery`. `failing` when any sink's last attempt failed; `delivering` when every sink that has been
 * attempted last took a delivery; `idle` when no sink has been attempted yet.
 */
export const SHIP_DELIVERY_STATES = ["delivering", "failing", "idle"] as const;
export type ShipDeliveryState = (typeof SHIP_DELIVERY_STATES)[number];

/** How delivery stands, from the given sinks' rows: one sink's for its own state, every declared sink's for the total. */
export function shipDelivery(states: readonly AuditSinkStateRow[]): ShipDeliveryState {
  const attempted = states.filter((state) => state.lastDeliveredAt !== null || state.lastFailedAt !== null);
  if (attempted.length === 0) return "idle";
  const failing = attempted.some(
    (state) =>
      state.lastFailedAt !== null && (state.lastDeliveredAt === null || state.lastFailedAt > state.lastDeliveredAt),
  );
  return failing ? "failing" : "delivering";
}
