// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { base64UrlEncode } from "../controlPlane/token/base64url";
import { PithyError } from "../error/pithyError";
import { PRESENCE_TICKET_TTL_SECONDS } from "./declaration";
import {
  mintPresenceTicket,
  PRESENCE_TICKET_PROTOCOL_PREFIX,
  type PresenceTicketRequest,
  ticketFromOffer,
  verifyPresenceTicket,
} from "./ticket";

const REQUEST: PresenceTicketRequest = {
  kind: "support.thread",
  recordId: "th_1",
  ref: "agent-7",
  name: "Ada",
  origin: "control-plane",
};
const ROOM = { kind: "support.thread", recordId: "th_1" };
const KEYS = ["current-key"];
const NOW = new Date("2026-10-26T12:00:00.000Z");

async function refused(run: Promise<unknown>): Promise<string> {
  const error = await run.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(PithyError);
  const payload = (error as PithyError).payload;
  expect(payload.code).toBe("core/presence_ticket_invalid");
  expect(payload.status).toBe(401);
  return String(payload.detail);
}

describe("a presence ticket", () => {
  test("verifies for the room it names, and carries the participant", async () => {
    const { ticket, claims } = await mintPresenceTicket(REQUEST, KEYS, NOW);
    expect(claims.exp).toBe(NOW.getTime() / 1000 + PRESENCE_TICKET_TTL_SECONDS);
    const verified = await verifyPresenceTicket(ticket, ROOM, KEYS, NOW);
    expect(verified).toEqual(claims);
    expect(verified).toMatchObject({ ref: "agent-7", name: "Ada", origin: "control-plane" });
  });

  test("every ticket has its own id", async () => {
    const one = await mintPresenceTicket(REQUEST, KEYS, NOW);
    const two = await mintPresenceTicket(REQUEST, KEYS, NOW);
    expect(one.claims.id).not.toBe(two.claims.id);
  });

  test("expires 60 seconds after minting", async () => {
    const { ticket } = await mintPresenceTicket(REQUEST, KEYS, NOW);
    const later = new Date(NOW.getTime() + 59_000);
    await expect(verifyPresenceTicket(ticket, ROOM, KEYS, later)).resolves.toBeDefined();
    const expired = new Date(NOW.getTime() + PRESENCE_TICKET_TTL_SECONDS * 1000);
    expect(await refused(verifyPresenceTicket(ticket, ROOM, KEYS, expired))).toContain("expired");
  });

  test("is refused at another room — another record, or another kind", async () => {
    const { ticket } = await mintPresenceTicket(REQUEST, KEYS, NOW);
    expect(await refused(verifyPresenceTicket(ticket, { ...ROOM, recordId: "th_2" }, KEYS, NOW))).toContain(
      "presented at",
    );
    expect(await refused(verifyPresenceTicket(ticket, { ...ROOM, kind: "support.inbox" }, KEYS, NOW))).toContain(
      "presented at",
    );
  });

  test("signed with a key this Worker does not honor is refused", async () => {
    const { ticket } = await mintPresenceTicket(REQUEST, ["someone-elses"], NOW);
    expect(await refused(verifyPresenceTicket(ticket, ROOM, KEYS, NOW))).toContain("signature");
  });

  test("survives a rotation: a ticket signed with the outgoing key verifies while it is still honored", async () => {
    const { ticket } = await mintPresenceTicket(REQUEST, ["outgoing"], NOW);
    await expect(verifyPresenceTicket(ticket, ROOM, ["incoming", "outgoing"], NOW)).resolves.toBeDefined();
  });

  test("with its claims rewritten is refused, whatever they now say", async () => {
    const { ticket } = await mintPresenceTicket(REQUEST, KEYS, NOW);
    const [, signature] = ticket.split(".");
    const forged = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ ...REQUEST, v: 1, id: crypto.randomUUID(), name: "Root", exp: 1 })),
    );
    expect(await refused(verifyPresenceTicket(`${forged}.${signature}`, ROOM, KEYS, NOW))).toContain("signature");
  });

  test("that claims to live longer than a ticket can is refused, even correctly signed", async () => {
    const long = new Date(NOW.getTime() + 10 * 60_000);
    const { ticket } = await mintPresenceTicket(REQUEST, KEYS, long);
    expect(await refused(verifyPresenceTicket(ticket, ROOM, KEYS, NOW))).toContain("beyond the ticket lifetime");
  });

  test("that is not a ticket at all is refused, one way", async () => {
    for (const junk of ["", "abc", "a.b.c", "!!.??", "e30.AAAA"]) {
      await refused(verifyPresenceTicket(junk, ROOM, KEYS, NOW));
    }
  });
});

describe("ticketFromOffer", () => {
  test("reads the one ticket beside the subprotocol", () => {
    expect(ticketFromOffer(`pithy.presence.v1, ${PRESENCE_TICKET_PROTOCOL_PREFIX}abc.def`)).toBe("abc.def");
  });

  test("no ticket, and two tickets, are both none", () => {
    expect(ticketFromOffer("pithy.presence.v1")).toBeUndefined();
    expect(ticketFromOffer(null)).toBeUndefined();
    expect(ticketFromOffer("pithy.ticket.a.b, pithy.ticket.c.d")).toBeUndefined();
  });
});
