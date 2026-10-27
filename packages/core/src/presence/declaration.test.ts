// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import {
  assertPresenceDeclaration,
  DEFAULT_PRESENCE_PARTICIPANTS,
  MAX_PRESENCE_PARTICIPANTS,
  type PresenceDeclaration,
  type PresenceRoomKind,
  participantCap,
  presenceRoomPath,
  presenceSocketPath,
  presenceTicketPath,
  resolveTicketKeys,
  sessionParticipantName,
} from "./declaration";
import { PresenceParticipantName } from "./frames";

const thread: PresenceRoomKind = {
  kind: "support.thread",
  scope: "support:threads:read",
  activities: ["viewing", "replying"],
};

function declaration(rooms: PresenceRoomKind[], basePath = "/support"): PresenceDeclaration {
  return { basePath, rooms, ticketKey: "k" };
}

/** The capability's own admin routes: the scope the room joins with is the one its thread reads require. */
const routes = [
  { method: "GET", scope: "support:threads:read" },
  { method: "GET", scope: "support:inbox:read" },
  { method: "POST", scope: "support:threads:write" },
] as const;

const check = (
  presence: PresenceDeclaration,
  adminRoutes: readonly { method: string; scope: string | null }[] = routes,
) => assertPresenceDeclaration("support", presence, adminRoutes);

function refusal(run: () => void): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PithyError);
    return String((error as PithyError).payload.detail);
  }
  throw new Error("expected a refusal");
}

describe("assertPresenceDeclaration", () => {
  test("a well-formed declaration passes", () => {
    expect(() => check(declaration([thread]))).not.toThrow();
  });

  test("a kind outside the capability's own name is refused, naming the prefix it needs", () => {
    const detail = refusal(() => check(declaration([{ ...thread, kind: "ledger.account" }])));
    expect(detail).toContain('must start with "support."');
  });

  test("a kind that is not a kind name is refused", () => {
    expect(refusal(() => check(declaration([{ ...thread, kind: "support" }])))).toContain("is not a kind name");
  });

  test("a kind declared twice is refused", () => {
    expect(refusal(() => check(declaration([thread, thread])))).toContain("twice");
  });

  test("a scope that is not a control-plane scope is refused", () => {
    expect(refusal(() => check(declaration([{ ...thread, scope: "Support Read" }])))).toContain("is not a scope");
  });

  test("a scope no admin route of the capability requires is refused, since no grant would ever offer it", () => {
    // A scope of its own, a near-miss of the one its routes gate, and a capability with no admin routes at all.
    for (const [scope, adminRoutes] of [
      ["support:presence:join", routes],
      ["support:thread:read", routes],
      ["support:threads:read", []],
    ] as const) {
      expect(refusal(() => check(declaration([{ ...thread, scope }]), adminRoutes))).toContain(
        "no admin route of support requires",
      );
    }
  });

  test("a scope that also gates a write is refused: joining a room must never need a mutation grant", () => {
    expect(refusal(() => check(declaration([{ ...thread, scope: "support:threads:write" }])))).toContain(
      "gates a POST",
    );
    const mixed = [...routes, { method: "DELETE", scope: "support:threads:read" }];
    expect(refusal(() => check(declaration([thread]), mixed))).toContain("gates a DELETE");
  });

  test("a scope another capability's routes require is refused, since it is not this capability's to lend", () => {
    expect(refusal(() => check(declaration([{ ...thread, scope: "ledger:accounts:read" }])))).toContain(
      "no admin route of support requires",
    );
  });

  test("an activity that is not one word, a duplicate, and too many are each refused", () => {
    expect(refusal(() => check(declaration([{ ...thread, activities: ["viewing", "Free text"] }])))).toContain(
      "is not one word",
    );
    expect(refusal(() => check(declaration([{ ...thread, activities: ["viewing", "viewing"] }])))).toContain("twice");
    const many = Array.from({ length: 17 }, (_, index) => `a${index}`) as [string, ...string[]];
    expect(refusal(() => check(declaration([{ ...thread, activities: many }])))).toContain("activities");
  });

  test("a participant cap outside 1 to the ceiling is refused", () => {
    for (const maxParticipants of [0, MAX_PRESENCE_PARTICIPANTS + 1, 2.5]) {
      expect(refusal(() => check(declaration([{ ...thread, maxParticipants }])))).toContain("maxParticipants");
    }
  });

  test("a base path with no leading slash, or a trailing one, is refused", () => {
    for (const basePath of ["support", "/support/"]) {
      expect(refusal(() => check(declaration([thread], basePath)))).toContain("basePath");
    }
  });
});

describe("paths", () => {
  test("every path hangs off the capability's own base path", () => {
    expect(presenceTicketPath("/help")).toBe("/help/presence/tickets");
    expect(presenceSocketPath("/help")).toBe("/help/presence/rooms/:kind/:recordId");
    expect(presenceRoomPath("/help", "support.thread", "th_1:a")).toBe("/help/presence/rooms/support.thread/th_1%3Aa");
  });

  test("a kind with no cap runs at the default", () => {
    expect(participantCap(thread)).toBe(DEFAULT_PRESENCE_PARTICIPANTS);
    expect(participantCap({ ...thread, maxParticipants: 3 })).toBe(3);
  });
});

describe("resolveTicketKeys", () => {
  test("a string, a list, and a resolver all resolve to a list, blanks dropped", async () => {
    expect(await resolveTicketKeys("one", {})).toEqual(["one"]);
    expect(await resolveTicketKeys(["new", "", "old"], {})).toEqual(["new", "old"]);
    expect(await resolveTicketKeys(async (env) => String(env.KEY), { KEY: "from-env" })).toEqual(["from-env"]);
  });

  test("nothing usable is a configuration fault naming the secret, never the value", async () => {
    const error = await resolveTicketKeys(["", ""], {}).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("core/internal");
    expect((error as PithyError).payload.action).toContain("presence-ticket-key");
  });
});

describe("sessionParticipantName", () => {
  test("the gate's name, trimmed", () => {
    expect(sessionParticipantName("  Ada  ", "usr_1")).toBe("Ada");
  });

  test("the user id when the gate names none, or a name that is blank", () => {
    expect(sessionParticipantName(undefined, "usr_1")).toBe("usr_1");
    expect(sessionParticipantName("", "usr_1")).toBe("usr_1");
    expect(sessionParticipantName(" \t ", "usr_1")).toBe("usr_1");
  });

  test("cut to the 80 characters a participant name holds, never through a character", () => {
    const long = sessionParticipantName("a".repeat(200), "usr_1");
    expect(long).toBe("a".repeat(80));
    // An astral character is two UTF-16 units: the cut keeps it whole or drops it.
    const astral = sessionParticipantName(`${"a".repeat(79)}\u{1F600}tail`, "usr_1");
    expect(astral).toBe("a".repeat(79));
    expect(sessionParticipantName(`${"a".repeat(77)} \u{1F600}`, "usr_1")).toBe(`${"a".repeat(77)} \u{1F600}`);
    // A long user id as the fallback is cut the same way.
    expect(sessionParticipantName(undefined, "u".repeat(128))).toBe("u".repeat(80));
  });

  test("always a name the ticket accepts", () => {
    for (const name of [undefined, "", "   ", "x".repeat(81), `${" ".repeat(79)}y`, `${"y".repeat(79)}   z`]) {
      for (const userId of ["usr_1", "u".repeat(128), " "]) {
        expect(PresenceParticipantName.safeParse(sessionParticipantName(name, userId)).success).toBe(true);
      }
    }
  });
});
