// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { AUDIT_SHIP_BINDING, enqueueShipments, type ShipQueue } from "./queue";
import type { AuditSinks } from "./sinks";

/**
 * The recorder's `ship` hook over one env's queue binding (#824), or nothing when no sink is declared.
 *
 * The binding is read when an event is shipped, not when the hook is built: a Worker deployed before `pithy upgrade`
 * wrote the binding still records every event, and the shipment that could not be enqueued is said, never thrown
 * into the write.
 */
export function shipperFor(
  env: Record<string, unknown> | undefined,
  sinks: AuditSinks,
): ((event: { eventId: string; action: string }) => Promise<void>) | undefined {
  if (Object.keys(sinks).length === 0) return undefined;
  return async (event) => {
    const queue = env?.[AUDIT_SHIP_BINDING] as ShipQueue | undefined;
    if (typeof queue?.sendBatch !== "function") {
      throw new InternalError({
        message: "Audit sinks are declared and this Worker binds no shipping queue.",
        action: `Run ${pithyCommand("upgrade")} to write the ${AUDIT_SHIP_BINDING} queue binding, then ${pithyCommand("provision")}.`,
        detail: `no ${AUDIT_SHIP_BINDING} binding on env; event ${event.eventId} was recorded and not shipped`,
      });
    }
    await enqueueShipments(queue, sinks, event);
  };
}
