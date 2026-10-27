// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { auditDatabase } from "../data/tables";
import { audit_0006_sinks } from "../migrations/0006_sinks";
import { readSinkStates, recordSinkOutcome } from "./state";

/** Each sink's delivery state (#824), against a real D1. */

const db = () => auditDatabase(env.DB);

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_sinks").run();
  await audit_0006_sinks.up(db() as unknown as Kysely<unknown>);
});

const at = (ms: number) => new Date(ms);

async function stateOf(sink: string) {
  const [row] = await readSinkStates(db(), [sink]);
  return row;
}

describe("recordSinkOutcome", () => {
  test("a fresh row never starts below zero", async () => {
    await recordSinkOutcome(db(), "siem", { delivered: true, at: at(1000), retryingDelta: -3, deadLettered: 0 });
    expect(await stateOf("siem")).toEqual({
      sink: "siem",
      lastDeliveredAt: at(1000),
      lastFailedAt: null,
      retrying: 0,
      deadLettered: 0,
    });
  });

  test("a fresh failure records its time, its backlog and what it gave up on", async () => {
    await recordSinkOutcome(db(), "siem", { delivered: false, at: at(1000), retryingDelta: 2, deadLettered: 1 });
    expect(await stateOf("siem")).toEqual({
      sink: "siem",
      lastDeliveredAt: null,
      lastFailedAt: at(1000),
      retrying: 2,
      deadLettered: 1,
    });
  });

  test("each outcome moves only its own timestamp, the backlog by its delta, and dead letters accumulate", async () => {
    const step = (delivered: boolean, ms: number, retryingDelta: number, deadLettered: number) =>
      recordSinkOutcome(db(), "siem", { delivered, at: at(ms), retryingDelta, deadLettered });

    await step(true, 1000, 0, 0);
    expect(await stateOf("siem")).toMatchObject({ lastDeliveredAt: at(1000), lastFailedAt: null, retrying: 0 });

    await step(false, 2000, 3, 0);
    expect(await stateOf("siem")).toEqual({
      sink: "siem",
      lastDeliveredAt: at(1000),
      lastFailedAt: at(2000),
      retrying: 3,
      deadLettered: 0,
    });

    await step(false, 3000, -1, 1);
    expect(await stateOf("siem")).toEqual({
      sink: "siem",
      lastDeliveredAt: at(1000),
      lastFailedAt: at(3000),
      retrying: 2,
      deadLettered: 1,
    });

    await step(true, 4000, -2, 0);
    expect(await stateOf("siem")).toEqual({
      sink: "siem",
      lastDeliveredAt: at(4000),
      lastFailedAt: at(3000),
      retrying: 0,
      deadLettered: 1,
    });

    // More leaving than waiting — a redelivery that lands twice — clamps at zero on an existing row too.
    await step(true, 5000, -5, 0);
    expect(await stateOf("siem")).toMatchObject({ retrying: 0, deadLettered: 1, lastFailedAt: at(3000) });

    await step(false, 6000, 0, 2);
    expect(await stateOf("siem")).toMatchObject({ lastDeliveredAt: at(5000), lastFailedAt: at(6000), deadLettered: 3 });
  });

  test("sinks keep separate rows", async () => {
    await recordSinkOutcome(db(), "a", { delivered: false, at: at(1000), retryingDelta: 4, deadLettered: 0 });
    await recordSinkOutcome(db(), "b", { delivered: true, at: at(2000), retryingDelta: 0, deadLettered: 0 });
    expect(await stateOf("a")).toMatchObject({ retrying: 4, lastDeliveredAt: null });
    expect(await stateOf("b")).toMatchObject({ retrying: 0, lastFailedAt: null });
  });
});

describe("readSinkStates", () => {
  test("no sinks asked for is no rows, without a query", async () => {
    await recordSinkOutcome(db(), "siem", { delivered: true, at: at(1000), retryingDelta: 0, deadLettered: 0 });
    expect(await readSinkStates(db(), [])).toEqual([]);
  });

  test("reads only the names asked for; a name with no row is absent", async () => {
    await recordSinkOutcome(db(), "siem", { delivered: true, at: at(1000), retryingDelta: 0, deadLettered: 0 });
    await recordSinkOutcome(db(), "removed", { delivered: false, at: at(1000), retryingDelta: 9, deadLettered: 9 });
    const rows = await readSinkStates(db(), ["siem", "never-ran"]);
    expect(rows.map((row) => row.sink)).toEqual(["siem"]);
  });
});
