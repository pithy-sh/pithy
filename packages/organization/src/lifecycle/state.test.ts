// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { OrganizationLifecycleColumns, organizationStanding } from "./state";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("organizationStanding", () => {
  test("no columns set is active, and so is a row read before the columns existed", () => {
    expect(organizationStanding({}, NOW)).toEqual({ state: "active" });
    expect(
      organizationStanding({ suspendedAt: null, suspendedUntil: null, deletedAt: null, purgeAfter: null }, NOW),
    ).toEqual({ state: "active" });
  });

  test("a suspension with no end is in force until a reinstatement", () => {
    expect(organizationStanding({ suspendedAt: new Date(NOW.getTime() - HOUR) }, NOW)).toEqual({
      state: "suspended",
      until: null,
    });
  });

  test("a timed suspension is in force before its end and over at it, with nothing written", () => {
    const until = new Date(NOW.getTime() + HOUR);
    const columns = { suspendedAt: new Date(NOW.getTime() - HOUR), suspendedUntil: until };
    expect(organizationStanding(columns, NOW)).toEqual({ state: "suspended", until });
    // Exclusive: at the instant it names, the organization is active again.
    expect(organizationStanding(columns, until)).toEqual({ state: "active" });
    expect(organizationStanding(columns, new Date(until.getTime() + 1))).toEqual({ state: "active" });
  });

  test("deleted outranks suspended, and stays deleted past its window until the purge erases it", () => {
    const purgeAfter = new Date(NOW.getTime() - HOUR);
    expect(
      organizationStanding(
        { suspendedAt: new Date(NOW.getTime() - 2 * HOUR), deletedAt: new Date(NOW.getTime() - 3 * HOUR), purgeAfter },
        NOW,
      ),
    ).toEqual({ state: "deleted", purgeAfter });
  });
});

describe("OrganizationLifecycleColumns", () => {
  test("decodes the four ms-epoch columns off a row and drops everything else", () => {
    const parsed = OrganizationLifecycleColumns.parse({
      id: "ignored",
      suspendedAt: NOW.getTime(),
      suspendedUntil: null,
      deletedAt: null,
      purgeAfter: null,
    });
    expect(parsed).toEqual({ suspendedAt: NOW, suspendedUntil: null, deletedAt: null, purgeAfter: null });
  });
});
