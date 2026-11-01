// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { OpenRoom } from "../code/room";
import { MatchmakingGame } from "../config/config";
import type { Invite } from "../data/invite";
import type { WaitingEntry } from "../queue/matching";
import { adminGameView, adminInviteView, adminQueueTicket, adminRoomView } from "./views";

const NOW = new Date("2026-10-26T12:00:00.000Z");

describe("adminQueueTicket", () => {
  const entry: WaitingEntry = {
    userId: "u1",
    region: "eu",
    skill: 1500,
    skillBand: 100,
    enqueuedAt: Date.parse("2026-10-26T11:59:30.250Z"),
  };

  it("measures the wait from enqueuedAt to now, in milliseconds, and gives enqueuedAt as ISO-8601", () => {
    expect(adminQueueTicket(entry, NOW)).toEqual({
      userId: "u1",
      region: "eu",
      skill: 1500,
      skillBand: 100,
      enqueuedAt: "2026-10-26T11:59:30.250Z",
      waitingMs: 29_750,
    });
  });

  it("clamps the wait to 0 when now is earlier than enqueuedAt", () => {
    const early = new Date(entry.enqueuedAt - 5_000);
    expect(adminQueueTicket(entry, early).waitingMs).toBe(0);
  });

  it("passes a null skill and band through", () => {
    const ticket = adminQueueTicket({ ...entry, skill: null, skillBand: null }, NOW);
    expect(ticket.skill).toBeNull();
    expect(ticket.skillBand).toBeNull();
  });
});

describe("adminRoomView", () => {
  it("passes the capacity through and gives the dates as ISO-8601", () => {
    const room: OpenRoom = {
      code: "ABCD",
      hostId: "host",
      sessionId: "s1",
      occupancy: 1,
      usesRemaining: 3,
      createdAt: new Date("2026-10-26T11:00:00.000Z"),
      expiresAt: new Date("2026-10-26T13:00:00.000Z"),
    };
    expect(adminRoomView(room, 4)).toEqual({
      code: "ABCD",
      hostId: "host",
      sessionId: "s1",
      occupancy: 1,
      capacity: 4,
      usesRemaining: 3,
      createdAt: "2026-10-26T11:00:00.000Z",
      expiresAt: "2026-10-26T13:00:00.000Z",
    });
  });
});

describe("adminInviteView", () => {
  const invite: Invite = {
    id: "inv-1",
    gameKey: "chess",
    inviterId: "a",
    inviteeId: "b",
    status: "pending",
    sessionId: null,
    createdAt: new Date("2026-10-26T11:58:00.000Z"),
    respondedAt: null,
    cancelKey: "secret-key",
  };

  it("measures the age from createdAt to now, in milliseconds, and never carries the cancel key", () => {
    const view = adminInviteView(invite, NOW);
    expect(view).toEqual({
      id: "inv-1",
      gameKey: "chess",
      inviterId: "a",
      inviteeId: "b",
      createdAt: "2026-10-26T11:58:00.000Z",
      ageMs: 120_000,
    });
    expect(view).not.toHaveProperty("cancelKey");
  });

  it("clamps the age to 0 when now is earlier than createdAt", () => {
    const early = new Date(invite.createdAt.getTime() - 1_000);
    expect(adminInviteView(invite, early).ageMs).toBe(0);
  });
});

describe("adminGameView", () => {
  const snapshot = { kind: "connect-n", rules: {} };

  it("names the game's key, roster, pool, which paths are open, and the queue's longest banded wait", () => {
    const game = MatchmakingGame.parse({
      key: "ranked",
      players: 4,
      skillPool: "elo",
      snapshot,
      roomCodes: { enabled: false },
      queue: { maxWaitSeconds: 45 },
    });
    expect(adminGameView(game)).toEqual({
      key: "ranked",
      players: 4,
      skillPool: "elo",
      roomCodesEnabled: false,
      queueEnabled: true,
      maxWaitSeconds: 45,
    });
  });

  it("gives a game with no pool a null skillPool, and never carries the snapshot", () => {
    const view = adminGameView(MatchmakingGame.parse({ key: "duel", snapshot, queue: { enabled: false } }));
    expect(view).toEqual({
      key: "duel",
      players: 2,
      skillPool: null,
      roomCodesEnabled: true,
      queueEnabled: false,
      maxWaitSeconds: 120,
    });
    expect(view).not.toHaveProperty("snapshot");
  });
});
