// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { notificationTargets, projectionTargets } from "./targets";

/** The event's own provider time, and one strictly after it. */
const EVENT_AT = new Date("2026-02-10T12:00:00.000Z");
const LATER = new Date("2026-02-11T12:00:00.000Z");

/**
 * The facts the split reads off a projection, and nothing else. The row carries the event's own version
 * unless a case says a newer event has since moved it.
 */
const projected = (
  id: string,
  type: "subscription" | "consumable" | "non_consumable",
  outcome: "created" | "updated" | "ignored",
  rowAt: Date = EVENT_AT,
) => ({
  projection: { outcome, purchase: { id, type, providerEventAt: rowAt } },
  eventAt: EVENT_AT,
});

describe("projectionTargets (#830)", () => {
  test("a row the event created or moved is listed, split by whether it renews", () => {
    expect(
      projectionTargets([projected("p1", "consumable", "created"), projected("s1", "subscription", "updated")]),
    ).toEqual({ purchaseIds: ["p1"], subscriptionIds: ["s1"] });
  });

  test("a row a newer event has since moved is not one this event changed", () => {
    // The row is strictly newer than the event: the writer answers `ignored` and writes nothing, so naming it
    // would claim a change that did not happen.
    expect(projectionTargets([projected("s1", "subscription", "ignored", LATER)])).toEqual({
      purchaseIds: [],
      subscriptionIds: [],
    });
  });

  test("a row carrying this event's own version is this event's write, made on an earlier attempt", () => {
    // The first attempt projected and then failed after — a fulfillment that threw — so the retry finds its
    // own write and the writer answers `ignored`. Two empty lists there would say the event finished and
    // changed nothing, which is the answer worse than none.
    expect(projectionTargets([projected("p1", "consumable", "ignored")])).toEqual({
      purchaseIds: ["p1"],
      subscriptionIds: [],
    });
  });

  test("one notification touching several rows lists each once, in the order it wrote them", () => {
    // Lemon Squeezy's refund writes the invoice row and the standing row; a second projection of the same
    // row in one delivery is still one row.
    expect(
      projectionTargets([
        projected("s1", "subscription", "updated"),
        projected("s2", "subscription", "created"),
        projected("s1", "subscription", "updated"),
      ]),
    ).toEqual({ purchaseIds: [], subscriptionIds: ["s1", "s2"] });
  });

  test("nothing projected is the recorded empty answer", () => {
    expect(projectionTargets([])).toEqual({ purchaseIds: [], subscriptionIds: [] });
  });

  test("a notification's charge and standing are each judged against their own event", () => {
    // The standing's event is newer than the charge's. Its row carries the standing's own time, so it was this
    // notification's write even though it is newer than the charge.
    const charge = projected("s1", "subscription", "ignored").projection;
    const standing = projected("s2", "subscription", "ignored", LATER).projection;
    expect(
      notificationTargets(
        { event: { providerEventAt: EVENT_AT }, projection: charge },
        { event: { providerEventAt: LATER }, projection: standing },
      ),
    ).toEqual({ purchaseIds: [], subscriptionIds: ["s1", "s2"] });
    // No standing event, no standing row.
    expect(notificationTargets({ event: { providerEventAt: EVENT_AT }, projection: charge }, { event: null })).toEqual({
      purchaseIds: [],
      subscriptionIds: ["s1"],
    });
  });
});
