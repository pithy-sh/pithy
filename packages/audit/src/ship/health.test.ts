// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test } from "vitest";
import type { AuditSinkStateRow } from "../data/sinkState";
import { shipDelivery } from "./health";

const row = (sink: string, delivered: number | null, failed: number | null): AuditSinkStateRow => ({
  sink,
  lastDeliveredAt: delivered === null ? null : new Date(delivered),
  lastFailedAt: failed === null ? null : new Date(failed),
  retrying: 0,
  deadLettered: 0,
});

describe("shipDelivery", () => {
  test("idle when no sink has been attempted", () => {
    expect(shipDelivery([])).toBe("idle");
    expect(shipDelivery([row("a", null, null)])).toBe("idle");
  });

  test("delivering when every attempted sink last took a delivery", () => {
    expect(shipDelivery([row("a", 20, 10), row("b", 5, null), row("c", null, null)])).toBe("delivering");
  });

  test("failing when any sink's last attempt failed", () => {
    expect(shipDelivery([row("a", 20, 10), row("b", 5, 30)])).toBe("failing");
    expect(shipDelivery([row("a", null, 1)])).toBe("failing");
  });
});
