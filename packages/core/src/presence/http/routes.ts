// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { Context, Hono } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { remedy } from "../../cli/command";
import { ForbiddenError, InternalError, NotFoundError, PresenceTicketInvalidError } from "../../error/pithyError";
import { describeRoute } from "../../http/routeSpec";
import { requireSameOrigin } from "../../http/sameOrigin";
import { SUBPROTOCOL_HEADER } from "../../http/subprotocol";
import { validate } from "../../http/validation";
import {
  PRESENCE_ROOMS_BINDING,
  type PresenceDeclaration,
  type PresenceRoomKind,
  participantCap,
  presenceRoomPath,
  presenceSocketPath,
  presenceTicketPath,
  resolveTicketKeys,
  sessionParticipantName,
} from "../declaration";
import { PRESENCE_ADMISSION_HEADER, type PresenceAdmission } from "../room";
import { mintPresenceTicket, type PresenceTicketRequest, ticketFromOffer, verifyPresenceTicket } from "../ticket";
import { requireAuth } from "./guard";
import { type PresenceRoomDescriptor, PresenceTicket } from "./responses";
import { PresenceRoomParams, PresenceSessionTicketRequest } from "./schemas";

/**
 * A capability's presence routes, mounted by `createBackend` under the `basePath` it declared:
 *
 *   POST {base}/presence/tickets                   → a ticket for a signed-in user   (bearer | session)
 *   GET  {base}/presence/rooms/:kind/:recordId     → the room's socket               (a ticket)
 *
 * The control-plane door is the seam's own, `POST /control-plane/presence/tickets`, because one management
 * client reaches every capability's rooms through it; both doors answer the same {@link PresenceTicket}.
 */

/** Find a declared room kind, or the 404 an undeclared one is. */
export function roomKind(presence: PresenceDeclaration, kind: string): PresenceRoomKind {
  const room = presence.rooms.find((candidate) => candidate.kind === kind);
  if (!room) throw new NotFoundError({ message: "That room kind does not exist.", params: { kind } });
  return room;
}

/** Mint the ticket a door answers with. */
export async function issuePresenceTicket(
  c: Context<PithyHonoEnv>,
  presence: PresenceDeclaration,
  request: PresenceTicketRequest,
): Promise<PresenceTicket> {
  const keys = await resolveTicketKeys(presence.ticketKey, c.env as Record<string, unknown>);
  const { ticket, claims } = await mintPresenceTicket(request, keys);
  return {
    ticket,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    kind: claims.kind,
    recordId: claims.recordId,
    socketPath: presenceRoomPath(presence.basePath, claims.kind, claims.recordId),
    protocol: "pithy.presence.v1",
  };
}

/** The room kinds a declaration serves, as the manifest reports them. */
export function describePresenceRooms(presence: PresenceDeclaration): PresenceRoomDescriptor[] {
  return presence.rooms.map((room) => ({
    kind: room.kind,
    scope: room.scope,
    activities: [...room.activities],
    maxParticipants: participantCap(room),
    sessionTicketPath: room.session ? presenceTicketPath(presence.basePath) : null,
    socketPath: presenceSocketPath(presence.basePath),
  }));
}

export function registerPresenceRoutes(app: Hono<PithyHonoEnv>, presence: PresenceDeclaration): void {
  app.post(
    presenceTicketPath(presence.basePath),
    describeRoute({
      summary: "Mint a presence ticket for the signed-in user.",
      description:
        "Admits the caller to one room of a kind this capability declares, when the capability's own read permission admits them to the record. Single use, for 60 seconds. Open the socket at `socketPath`, offering `protocol` and `pithy.ticket.<ticket>` in `Sec-WebSocket-Protocol`.",
      verification: ["bearer", "session"],
      responses: { 201: PresenceTicket },
    }),
    requireAuth(),
    requireSameOrigin(),
    validate("json", PresenceSessionTicketRequest),
    async (c) => {
      const body = c.req.valid("json");
      const room = roomKind(presence, body.kind);
      const auth = c.var.auth;
      // `requireAuth` ran; this is the type system catching up.
      if (!auth) throw new InternalError({ detail: "presence session ticket reached without auth" });
      const grant = room.session ? await room.session(c, body.recordId) : null;
      if (!grant) {
        throw new ForbiddenError({
          message: "You cannot join that room.",
          detail: room.session
            ? `session gate refused ${body.kind}/${body.recordId}`
            : `${body.kind} admits management clients only`,
        });
      }
      const ticket = await issuePresenceTicket(c, presence, {
        kind: room.kind,
        recordId: body.recordId,
        ref: auth.userId,
        name: sessionParticipantName(grant.name, auth.userId),
        origin: "session",
      });
      return c.json(ticket satisfies PresenceTicket, 201);
    },
  );

  app.get(
    presenceSocketPath(presence.basePath),
    describeRoute({
      summary: "Open a presence room's socket.",
      description:
        "Send `Upgrade: websocket` and offer `pithy.presence.v1` and `pithy.ticket.<ticket>` in `Sec-WebSocket-Protocol`; the ticket is the credential, minted by either ticket route for this room. The socket receives who is in the room, then joins, leaves and activity changes as they happen. The frames are in the AsyncAPI contract.",
      verification: "public",
      responses: {
        101: { description: "Switches to a WebSocket. The room pushes presence frames as JSON text." },
      },
    }),
    validate("param", PresenceRoomParams),
    async (c) => {
      const { kind, recordId } = c.req.valid("param");
      const room = roomKind(presence, kind);
      const ticket = ticketFromOffer(c.req.header(SUBPROTOCOL_HEADER));
      if (ticket === undefined) throw new PresenceTicketInvalidError({ detail: "no single ticket in the offer" });
      const keys = await resolveTicketKeys(presence.ticketKey, c.env as Record<string, unknown>);
      const claims = await verifyPresenceTicket(ticket, { kind, recordId }, keys);

      const admission: PresenceAdmission = {
        kind,
        recordId,
        ref: claims.ref,
        name: claims.name,
        origin: claims.origin,
        ticket: { id: claims.id, exp: claims.exp },
        activities: [...room.activities],
        maxParticipants: participantCap(room),
      };
      // A fresh request, so the admission header is ours whatever the client sent under that name.
      const request = new Request(c.req.url, c.req.raw);
      request.headers.set(PRESENCE_ADMISSION_HEADER, JSON.stringify(admission));
      return roomStub(c, kind, recordId).fetch(request);
    },
  );
}

/** The one room for this record. */
function roomStub(c: Context<PithyHonoEnv>, kind: string, recordId: string) {
  const ns = (c.env as Record<string, unknown>)[PRESENCE_ROOMS_BINDING] as DurableObjectNamespace | undefined;
  if (!ns) {
    throw new InternalError({
      message: "Presence is not available right now.",
      action: `Bind the ${PRESENCE_ROOMS_BINDING} Durable Object. ${remedy("upgrade", {}, { runtime: true }).say((command) => `${command} writes it.`)}`,
      detail: `no ${PRESENCE_ROOMS_BINDING} binding`,
    });
  }
  return ns.get(ns.idFromName(`${kind}:${recordId}`)) as unknown as { fetch(request: Request): Promise<Response> };
}
