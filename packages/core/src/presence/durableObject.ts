// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DurableObject } from "cloudflare:workers";
import { clientError } from "../error/client";
import {
  fromZodError,
  PithyError,
  PresenceRoomFullError,
  PresenceTicketInvalidError,
  ValidationError,
} from "../error/pithyError";
import { negotiateSubprotocol, SUBPROTOCOL_HEADER } from "../http/subprotocol";
import { PRESENCE_MAX_FRAME_BYTES } from "./declaration";
import {
  PRESENCE_ROOM_VERSIONS,
  type PresenceParticipant,
  PresenceRoomClientFrame,
  PresenceRoomPing,
  PresenceRoomPong,
  type PresenceRoomServerFrame,
} from "./frames";
import {
  admit,
  carrySpent,
  declaresActivity,
  inheritSpent,
  PRESENCE_ADMISSION_HEADER,
  PresenceAdmission,
  PresenceAttachment,
  type SpentTicket,
} from "./room";

/**
 * **One presence room: who has one record open, and what they are doing.** Addressed by `<kind>:<recordId>`,
 * so each record has its own object.
 *
 * The Hibernation API only: `ctx.acceptWebSocket`, never `ws.accept()`, and no registry of sockets in
 * memory — the participants are read back from `getWebSockets()`, each from its own attachment, so a room
 * that hibernates and wakes knows exactly who is in it. Nothing is written to Durable Object storage: the
 * room holds nothing but who is here, and when the last socket closes it is gone.
 *
 * The upgrade is forwarded by the Worker's socket route, which has verified the ticket and states the
 * admission on {@link PRESENCE_ADMISSION_HEADER}. The room trusts that header — a Durable Object is reached
 * only through its binding — and decides the two things only it can: whether the ticket is already spent, and
 * whether the room is full.
 */
export class PresenceRoom extends DurableObject<Record<string, unknown>> {
  /**
   * Tickets redeemed by sockets that closed while no other socket was left to carry them. Memory, not
   * storage, and only while the room is empty: the next socket to join takes them into its attachment, and
   * until one does, {@link awake} keeps the room from hibernating and losing them.
   */
  private remembered: SpentTicket[] = [];

  /**
   * The timer that holds an empty room awake until the last remembered ticket would expire. A Durable Object
   * with no socket hibernates after about ten seconds idle and loses its memory, which would let a spent
   * ticket in again; a pending timer is one of the things that stops it. With no timer, an idle object that
   * cannot hibernate is evicted only after 70 seconds or more — past a 60-second ticket's life. A deploy or a
   * restart still clears it, and drops every socket with it.
   */
  private awake: { until: number; timer: ReturnType<typeof setTimeout> } | null = null;

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    try {
      const admission = this.admission(request);
      const version = negotiateSubprotocol(request.headers.get(SUBPROTOCOL_HEADER), PRESENCE_ROOM_VERSIONS);
      if (version === null) throw new ValidationError({ message: "Offer pithy.presence.v1." });

      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const present = this.attachments();
      // A socket closing whose close event has not yet run still holds its ticket and what it carries.
      const leaving = this.leavingAttachments().flatMap((attachment) => [attachment.ticket, ...attachment.spent]);
      const refusal = admit(admission, present, [...this.remembered, ...leaving], nowSeconds);
      if (refusal === "spent")
        throw new PresenceTicketInvalidError({ detail: `ticket ${admission.ticket.id} is spent` });
      if (refusal === "full") {
        throw new PresenceRoomFullError({
          detail: `${admission.kind}/${admission.recordId} at ${admission.maxParticipants}`,
        });
      }

      const participant: PresenceParticipant = {
        id: crypto.randomUUID(),
        ref: admission.ref,
        name: admission.name,
        origin: admission.origin,
        activity: admission.activities[0] as string,
        joinedAt: now.toISOString(),
      };
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        participant,
        version,
        ticket: admission.ticket,
        activities: admission.activities,
        spent: inheritSpent(this.remembered, admission.ticket.id, nowSeconds),
      } satisfies PresenceAttachment);
      // On a socket now, which survives hibernation; the room's memory need not hold them, nor stay awake to.
      this.remembered = [];
      this.stayAwake(nowSeconds);

      // In the order they joined. The runtime hands sockets back in no promised order.
      const everyone = [...present.map((attachment) => attachment.participant), participant].sort((a, b) =>
        a.joinedAt.localeCompare(b.joinedAt),
      );
      server.send(render({ type: "init", self: participant.id, participants: everyone }));
      this.broadcast({ type: "joined", participant }, server);

      // A browser drops a socket whose 101 does not name the subprotocol it chose.
      return new Response(null, { status: 101, webSocket: client, headers: { [SUBPROTOCOL_HEADER]: version } });
    } catch (error) {
      if (!(error instanceof PithyError)) throw error;
      return Response.json({ error: clientError(error.payload) }, { status: error.payload.status });
    }
  }

  /**
   * One frame from a participant: `ping`, or `set_activity` naming an activity the room kind declares. A frame
   * past the size limit, one that does not parse, and an undeclared activity are each answered with an error
   * frame and change nothing.
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachmentOf(ws);
    if (!attachment) return;
    const bytes = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    try {
      if (bytes > PRESENCE_MAX_FRAME_BYTES) {
        throw new ValidationError({
          message: `A frame is at most ${PRESENCE_MAX_FRAME_BYTES} bytes.`,
          detail: `${bytes} bytes`,
        });
      }
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (PresenceRoomPing.safeParse(text).success) {
        ws.send(PresenceRoomPong.value);
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ValidationError({ message: "This socket accepts `ping` and JSON frames." });
      }
      const parsed = PresenceRoomClientFrame.safeParse(json);
      if (!parsed.success) throw fromZodError(parsed.error, { message: "This socket accepts `set_activity`." });
      const frame = parsed.data;
      if (!declaresActivity(attachment, frame.activity)) {
        throw new ValidationError({
          message: `This room's activities are ${attachment.activities.join(", ")}.`,
          params: { activity: frame.activity },
        });
      }
      if (frame.activity === attachment.participant.activity) return;
      const participant = { ...attachment.participant, activity: frame.activity };
      ws.serializeAttachment({ ...attachment, participant } satisfies PresenceAttachment);
      this.broadcast({ type: "activity", participantId: participant.id, activity: frame.activity }, ws);
    } catch (error) {
      if (!(error instanceof PithyError)) throw error;
      try {
        ws.send(render({ type: "error", error: clientError(error.payload) }));
      } catch {
        // Closing — nothing to answer.
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  /** A socket leaves: everyone else hears it, and the ticket it spent stays spent. */
  private leave(ws: WebSocket): void {
    const closing = this.attachmentOf(ws);
    if (closing) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const survivors = this.sockets().filter((other) => other !== ws);
      const [carrier] = survivors;
      const carried = carrier ? this.attachmentOf(carrier) : undefined;
      if (carrier && carried) {
        const spent = carrySpent(carried, closing, nowSeconds);
        if (spent) carrier.serializeAttachment({ ...carried, spent } satisfies PresenceAttachment);
      } else {
        this.remembered = [...this.remembered, closing.ticket, ...closing.spent];
        this.stayAwake(nowSeconds);
      }
      // Cleared before the broadcast, so a second close event for this socket cannot announce it twice.
      ws.serializeAttachment(null);
      this.broadcast({ type: "left", participantId: closing.participant.id }, ws);
    }
    try {
      ws.close();
    } catch {
      // Already closing.
    }
  }

  /**
   * Hold the room awake until the last remembered ticket would expire, or let it sleep when there is none.
   * The timer wakes once that has passed and lets go.
   */
  private stayAwake(nowSeconds: number): void {
    this.remembered = this.remembered.filter((ticket) => ticket.exp > nowSeconds);
    const until = Math.max(0, ...this.remembered.map((ticket) => ticket.exp));
    if (this.awake && this.remembered.length > 0 && this.awake.until >= until) return;
    if (this.awake) clearTimeout(this.awake.timer);
    this.awake = null;
    if (this.remembered.length === 0) return;
    const timer = setTimeout(
      () => {
        this.awake = null;
        this.stayAwake(Math.floor(Date.now() / 1000));
      },
      (until - nowSeconds + 1) * 1000,
    );
    this.awake = { until, timer };
  }

  /** Send a frame to every participant but one. One dead socket never blocks the rest. */
  private broadcast(frame: PresenceRoomServerFrame, except: WebSocket): void {
    const text = render(frame);
    for (const ws of this.sockets()) {
      if (ws === except || !this.attachmentOf(ws)) continue;
      try {
        ws.send(text);
      } catch {
        // A dead socket: its close event removes it.
      }
    }
  }

  /** The open sockets the runtime holds for this room. */
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  /** The attachments of sockets the runtime still holds but that are no longer open. */
  private leavingAttachments(): PresenceAttachment[] {
    return this.ctx.getWebSockets().flatMap((ws) => {
      if (ws.readyState === WebSocket.OPEN) return [];
      const attachment = this.attachmentOf(ws);
      return attachment ? [attachment] : [];
    });
  }

  /** Every participant's attachment, read back from the runtime. */
  private attachments(): PresenceAttachment[] {
    return this.sockets().flatMap((ws) => {
      const attachment = this.attachmentOf(ws);
      return attachment ? [attachment] : [];
    });
  }

  private attachmentOf(ws: WebSocket): PresenceAttachment | undefined {
    const parsed = PresenceAttachment.safeParse(ws.deserializeAttachment());
    return parsed.success ? parsed.data : undefined;
  }

  /** The admission the Worker forwarded. Missing or malformed is a request that did not come through the route. */
  private admission(request: Request): PresenceAdmission {
    const raw = request.headers.get(PRESENCE_ADMISSION_HEADER);
    let json: unknown;
    try {
      json = raw === null ? null : JSON.parse(raw);
    } catch {
      json = null;
    }
    const parsed = PresenceAdmission.safeParse(json);
    if (!parsed.success) throw new PresenceTicketInvalidError({ detail: "no admission on the forwarded upgrade" });
    return parsed.data;
  }
}

function render(frame: PresenceRoomServerFrame): string {
  return JSON.stringify(frame);
}
