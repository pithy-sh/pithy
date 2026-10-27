// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context, MiddlewareHandler } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { NotFoundError } from "../../error/pithyError";
import type { PresenceTicket } from "../../presence/http/responses";
import { issuePresenceTicket, roomKind } from "../../presence/http/routes";
import type { ControlPlanePresenceTicketRequest } from "../../presence/http/schemas";
import { ANY_VERIFIED_CALLER, type ControlPlaneRequirement } from "../scope/scope";
import { type ControlPlaneRequirementResolver, requireControlPlaneFor } from "./guard";
import type { ControlPlaneHandlerDeps } from "./handlers";

/**
 * `POST /control-plane/presence/tickets` — a ticket into any room this Worker composes, for a management
 * client.
 *
 * **The scope is the room kind's, and the gate checks it.** Which scope a call needs is named in its body, so
 * {@link presenceTicketRequirement} reads the kind from a copy of the body before the gate verifies, and the
 * gate then verifies against that kind's scope exactly as it would against a route's own: one allowed row
 * when it covers, one denial row naming the kind's scope when it does not, never both. Presence adds no scope
 * of its own: a connection that may read a record may see who else has it open.
 *
 * A body that names no declared kind needs only a verified caller, so an unverified one is refused before any
 * kind is looked at, and a verified one then gets the handler's 404 — the manifest lists every kind, so its
 * existence is no secret.
 */
export function presenceTicketRequirement(deps: ControlPlaneHandlerDeps): ControlPlaneRequirementResolver {
  return async (c) => {
    const kind = await bodyKind(c.req.raw);
    const presence = kind === undefined ? undefined : deps.composedPresence().get(kind);
    if (kind === undefined || !presence) return ANY_VERIFIED_CALLER;
    return roomKind(presence, kind).scope as ControlPlaneRequirement;
  };
}

/** The gate the route wears: {@link requireControlPlaneFor} over the room kind's scope. */
export function presenceTicketGate(deps: ControlPlaneHandlerDeps): MiddlewareHandler<PithyHonoEnv> {
  return requireControlPlaneFor(presenceTicketRequirement(deps));
}

/**
 * The body's `kind`, read from a copy so the route's validator still reads the original. Only to choose a
 * scope: the validator is what parses the body, and anything unreadable here is simply no kind.
 */
async function bodyKind(request: Request): Promise<string | undefined> {
  try {
    const body: unknown = await request.clone().json();
    const kind = typeof body === "object" && body !== null ? (body as { kind?: unknown }).kind : undefined;
    return typeof kind === "string" ? kind : undefined;
  } catch {
    return undefined;
  }
}

/** The handler, behind {@link presenceTicketGate}: the kind's scope is already verified, so it mints. */
export function presenceTicketHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>, body: ControlPlanePresenceTicketRequest): Promise<Response> => {
    const presence = deps.composedPresence().get(body.kind);
    if (!presence) throw new NotFoundError({ message: "That room kind does not exist.", params: { kind: body.kind } });
    const room = roomKind(presence, body.kind);
    const ticket = await issuePresenceTicket(c, presence, {
      kind: room.kind,
      recordId: body.recordId,
      ref: body.participant.ref,
      name: body.participant.name,
      origin: "control-plane",
    });
    return c.json(ticket satisfies PresenceTicket, 201);
  };
}
