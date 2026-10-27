// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  admit,
  carrySpent,
  declaresActivity,
  inheritSpent,
  MAX_CARRIED_SPENT,
  type PresenceAdmission,
  type PresenceAttachment,
} from "./room";

const NOW = 1_000;

function attachment(ticket: string, spent: { id: string; exp: number }[] = []): PresenceAttachment {
  return {
    participant: {
      id: crypto.randomUUID(),
      ref: ticket,
      name: ticket,
      origin: "session",
      activity: "viewing",
      joinedAt: "2026-10-26T12:00:00.000Z",
    },
    version: "pithy.presence.v1",
    ticket: { id: ticket, exp: NOW + 30 },
    activities: ["viewing", "replying"],
    spent,
  };
}

function admission(ticket: string, maxParticipants = 3): PresenceAdmission {
  return {
    kind: "support.thread",
    recordId: "th_1",
    ref: "u",
    name: "U",
    origin: "session",
    ticket: { id: ticket, exp: NOW + 60 },
    activities: ["viewing", "replying"],
    maxParticipants,
  };
}

const T = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe("admit", () => {
  test("admits a fresh ticket into a room with space", () => {
    expect(admit(admission(T(9)), [attachment(T(1))], [], NOW)).toBeNull();
  });

  test("refuses a ticket a socket in the room redeemed", () => {
    expect(admit(admission(T(1)), [attachment(T(1))], [], NOW)).toBe("spent");
  });

  test("refuses a ticket a closed socket redeemed, carried by a survivor or remembered by the room", () => {
    const carried = attachment(T(2), [{ id: T(1), exp: NOW + 30 }]);
    expect(admit(admission(T(1)), [carried], [], NOW)).toBe("spent");
    expect(admit(admission(T(1)), [], [{ id: T(1), exp: NOW + 30 }], NOW)).toBe("spent");
  });

  test("forgets a spent ticket once it would have expired anyway", () => {
    expect(admit(admission(T(1)), [], [{ id: T(1), exp: NOW }], NOW)).toBeNull();
  });

  test("refuses past the participant cap", () => {
    const room = [attachment(T(1)), attachment(T(2))];
    expect(admit(admission(T(9), 2), room, [], NOW)).toBe("full");
    expect(admit(admission(T(9), 3), room, [], NOW)).toBeNull();
  });
});

describe("carrySpent", () => {
  test("a survivor takes the closing socket's ticket and everything it carried", () => {
    const closing = attachment(T(1), [{ id: T(3), exp: NOW + 10 }]);
    const survivor = attachment(T(2));
    expect(carrySpent(survivor, closing, NOW)?.map((ticket) => ticket.id)).toEqual([T(1), T(3)]);
  });

  test("drops what has expired, and reports no change as null", () => {
    const closing = attachment(T(1));
    closing.ticket.exp = NOW;
    expect(carrySpent(attachment(T(2)), closing, NOW)).toBeNull();
  });
});

describe("inheritSpent", () => {
  test("a joining socket takes what the room remembers, unexpired, once each, never its own ticket", () => {
    const remembered = [
      { id: T(1), exp: NOW + 30 },
      { id: T(1), exp: NOW + 30 },
      { id: T(2), exp: NOW },
      { id: T(9), exp: NOW + 60 },
    ];
    expect(inheritSpent(remembered, T(9), NOW)).toEqual([{ id: T(1), exp: NOW + 30 }]);
  });

  test("keeps at most the cap, the latest to expire", () => {
    const many = Array.from({ length: MAX_CARRIED_SPENT + 5 }, (_, n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      exp: NOW + 1 + n,
    }));
    const kept = inheritSpent(many, "ffffffff-0000-4000-8000-000000000000", NOW);
    expect(kept).toHaveLength(MAX_CARRIED_SPENT);
    expect(Math.min(...kept.map((ticket) => ticket.exp))).toBe(NOW + 6);
  });
});

describe("declaresActivity", () => {
  test("only the room kind's declared values", () => {
    expect(declaresActivity(attachment(T(1)), "replying")).toBe(true);
    expect(declaresActivity(attachment(T(1)), "typing")).toBe(false);
  });
});
