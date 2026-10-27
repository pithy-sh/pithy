// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { base64UrlDecode, base64UrlEncode } from "../controlPlane/token/base64url";
import { PresenceTicketInvalidError } from "../error/pithyError";
import { PRESENCE_TICKET_TTL_SECONDS } from "./declaration";
import { PresenceOrigin, PresenceParticipantName, PresenceParticipantRef } from "./frames";
import { PresenceRecordId, PresenceRoomKindName } from "./names";

/**
 * **A presence ticket: single use, 60 seconds, one room, one participant.**
 *
 * `<claims>.<signature>`, both unpadded base64url, the signature an HMAC-SHA256 over the claims segment with
 * the Worker's `presence-ticket-key` secret. The alphabet and the dot are all token characters, so a
 * ticket rides in `Sec-WebSocket-Protocol` as `pithy.ticket.<ticket>` untouched.
 *
 * What a ticket proves is that **this Worker** minted it, behind a gate, for these claims. Verifying it
 * here checks the signature, the expiry and the room; spending it is the room's job, because only the room
 * the ticket names can redeem it, which is what makes "single use" decidable without a write anywhere.
 *
 * Every failure is the one {@link PresenceTicketInvalidError}, with the step in `detail` for the log: a caller
 * holding someone else's ticket learns that it does not work, never why.
 */

/** The subprotocol prefix a ticket travels under, beside `pithy.presence.v1`. */
export const PRESENCE_TICKET_PROTOCOL_PREFIX = "pithy.ticket.";

/** What a ticket says, signed. */
export const PresenceTicketClaims = z
  .object({
    v: z.literal(1).describe("The ticket format. A different one is refused."),
    id: z.string().uuid().describe("The ticket's own id — what the room records as spent."),
    kind: PresenceRoomKindName.describe("The room kind the ticket admits to."),
    recordId: PresenceRecordId.describe("The record the room is about."),
    ref: PresenceParticipantRef.describe(
      "Who the participant is: the client's opaque ref, or the signed-in user's id.",
    ),
    name: PresenceParticipantName.describe("How other participants see them."),
    origin: PresenceOrigin.describe("Which door the ticket was minted at."),
    exp: z.number().int().positive().describe("When the ticket stops being honored, in seconds since the epoch."),
  })
  .describe("The claims a presence ticket carries, signed by the Worker that minted it.");
export type PresenceTicketClaims = z.infer<typeof PresenceTicketClaims>;

/** What a caller asks a ticket for: everything but the id and the expiry, which the minter decides. */
export type PresenceTicketRequest = Omit<PresenceTicketClaims, "v" | "id" | "exp">;

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Mint a ticket. `keys[0]` signs. */
export async function mintPresenceTicket(
  request: PresenceTicketRequest,
  keys: readonly string[],
  now: Date = new Date(),
): Promise<{ ticket: string; claims: PresenceTicketClaims }> {
  const [signing] = keys;
  if (signing === undefined) throw new PresenceTicketInvalidError({ detail: "no signing key" });
  const claims = PresenceTicketClaims.parse({
    v: 1,
    id: crypto.randomUUID(),
    ...request,
    exp: Math.floor(now.getTime() / 1000) + PRESENCE_TICKET_TTL_SECONDS,
  });
  const body = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(signing), encoder.encode(body)));
  return { ticket: `${body}.${base64UrlEncode(signature)}`, claims };
}

/** Decode a segment, mapping the control-plane decoder's refusal onto this one. */
function decode(segment: string, what: string): Uint8Array {
  try {
    return base64UrlDecode(segment);
  } catch (cause) {
    throw new PresenceTicketInvalidError({ detail: `${what} is not base64url` }, { cause });
  }
}

/**
 * Verify a ticket for one room: the signature under any honored key, the expiry, and that it names this
 * kind and this record. Returns the claims; spending them is the room's.
 */
export async function verifyPresenceTicket(
  ticket: string,
  room: { kind: string; recordId: string },
  keys: readonly string[],
  now: Date = new Date(),
): Promise<PresenceTicketClaims> {
  const parts = ticket.split(".");
  const [body, signature] = parts;
  if (parts.length !== 2 || !body || !signature) throw new PresenceTicketInvalidError({ detail: "not two segments" });
  const signed = decode(signature, "signature");
  let authentic = false;
  for (const key of keys) {
    if (await crypto.subtle.verify("HMAC", await hmacKey(key), signed, encoder.encode(body))) {
      authentic = true;
      break;
    }
  }
  if (!authentic) throw new PresenceTicketInvalidError({ detail: "signature does not verify under any honored key" });

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(decode(body, "claims")));
  } catch (cause) {
    if (cause instanceof PresenceTicketInvalidError) throw cause;
    throw new PresenceTicketInvalidError({ detail: "claims are not JSON" }, { cause });
  }
  const parsed = PresenceTicketClaims.safeParse(json);
  if (!parsed.success) throw new PresenceTicketInvalidError({ detail: "claims do not parse" });
  const claims = parsed.data;

  const seconds = Math.floor(now.getTime() / 1000);
  if (claims.exp <= seconds) throw new PresenceTicketInvalidError({ detail: `expired at ${claims.exp}` });
  // A ticket living past its stated life was not minted here, whatever signed it.
  if (claims.exp > seconds + PRESENCE_TICKET_TTL_SECONDS) {
    throw new PresenceTicketInvalidError({ detail: `expiry ${claims.exp} is beyond the ticket lifetime` });
  }
  if (claims.kind !== room.kind || claims.recordId !== room.recordId) {
    throw new PresenceTicketInvalidError({
      detail: `minted for ${claims.kind}/${claims.recordId}, presented at ${room.kind}/${room.recordId}`,
    });
  }
  return claims;
}

/**
 * The ticket from a subprotocol offer, or `undefined` when none rides in it. More than one is refused as
 * none: an offer is one client's, and two tickets in it is not something a client means.
 */
export function ticketFromOffer(offered: string | null | undefined): string | undefined {
  const tickets = (offered ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.startsWith(PRESENCE_TICKET_PROTOCOL_PREFIX))
    .map((protocol) => protocol.slice(PRESENCE_TICKET_PROTOCOL_PREFIX.length));
  return tickets.length === 1 ? tickets[0] : undefined;
}
