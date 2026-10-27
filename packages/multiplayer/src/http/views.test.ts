// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { MultiplayerResult } from "../data/result";
import { AdminResultView, AdminSessionListItem, SessionResult } from "./responses";
import { adminResultView, adminSessionListItem, sessionResultView } from "./views";

const RESULT: MultiplayerResult = {
  id: 7,
  sessionId: "s1",
  gameKey: "duel",
  status: "resolved",
  players: ["ada", "bo"],
  scores: { ada: 1, bo: 0 },
  winnerUserId: "ada",
  draw: false,
  createdAt: new Date("2026-10-01T10:00:00.000Z"),
  resolvedAt: new Date("2026-10-01T10:05:00.000Z"),
  voidedAt: new Date("2026-10-02T09:00:00.000Z"),
  voidKey: "k1",
  voidConsumers: [
    { consumer: "leaderboard", status: "done", error: null },
    { consumer: "rating", status: "failed", error: { code: "core/internal", message: "The rating consumer failed." } },
  ],
};

describe("sessionResultView", () => {
  test("says when a result was voided, and never the void's key or its consumers", () => {
    const view = sessionResultView(RESULT);
    expect(SessionResult.parse(view)).toEqual(view);
    expect(view.voidedAt).toBe("2026-10-02T09:00:00.000Z");
    expect(JSON.stringify(view)).not.toContain("k1");
    expect(view).not.toHaveProperty("voidConsumers");
  });

  test("a result that counts reads voidedAt null", () => {
    expect(sessionResultView({ ...RESULT, voidedAt: null, voidKey: null, voidConsumers: null }).voidedAt).toBeNull();
  });
});

describe("adminResultView", () => {
  test("carries each consumer's recorded status, and never the key", () => {
    const view = adminResultView(RESULT);
    expect(AdminResultView.parse(view)).toEqual(view);
    expect(view.consumers.map((entry) => entry.status)).toEqual(["done", "failed"]);
    expect(JSON.stringify(view)).not.toContain("k1");
  });

  test("a result nobody voided has no consumers", () => {
    expect(adminResultView({ ...RESULT, voidedAt: null, voidKey: null, voidConsumers: null }).consumers).toEqual([]);
  });
});

describe("adminSessionListItem", () => {
  const entry = {
    id: 1,
    sessionId: "s1",
    gameKey: "duel",
    phase: "active" as const,
    players: ["ada"],
    openedAt: new Date("2026-10-01T10:00:00.000Z"),
  };

  test("reports age in whole seconds", () => {
    const item = adminSessionListItem(entry, new Date("2026-10-01T10:01:30.900Z"));
    expect(AdminSessionListItem.parse(item)).toEqual(item);
    expect(item.ageSeconds).toBe(90);
  });

  test("an opening time ahead of the clock reads as zero, never negative", () => {
    expect(adminSessionListItem(entry, new Date("2026-10-01T09:59:00.000Z")).ageSeconds).toBe(0);
  });
});
