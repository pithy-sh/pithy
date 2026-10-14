// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Invite } from "../data/invite";
import type { InviteView } from "./responses";

/**
 * The projections that fill the response schemas in `./responses`: each takes a stored row and returns
 * the view type `c.json` sends. Every invite on the wire goes through here — the HTTP invite routes and the
 * presence socket's `init` frame alike — so a column added to the table later reaches no client until it is
 * added here on purpose.
 */

/** One invite as the wire carries it, field by field, dates as ISO-8601. */
export function inviteView(invite: Invite): InviteView {
  return {
    id: invite.id,
    gameKey: invite.gameKey,
    inviterId: invite.inviterId,
    inviteeId: invite.inviteeId,
    status: invite.status,
    sessionId: invite.sessionId,
    createdAt: invite.createdAt.toISOString(),
    respondedAt: invite.respondedAt === null ? null : invite.respondedAt.toISOString(),
  };
}
