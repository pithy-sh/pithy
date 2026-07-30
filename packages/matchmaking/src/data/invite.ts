// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/** The lifecycle of a direct invite. */
export const InviteStatus = z
  .enum(["pending", "accepted", "declined"])
  .describe("A direct invite's state: awaiting a response, accepted (a session was minted), or declined.");
export type InviteStatus = z.infer<typeof InviteStatus>;

/**
 * A direct invite — one player asks another (by email or screen name, resolved to a user id) to play. The
 * row in `pithy_matchmaking_invites`. The id is a UUID (externally referenced in URLs), not an
 * autoincrement, to prevent enumeration.
 */
export const Invite = z
  .object({
    id: z.string().describe("The invite's UUID — the externally-referenced id."),
    gameKey: z.string().describe("The matchmaking game this invite is for."),
    inviterId: z.string().describe("The authenticated user who sent the invite."),
    inviteeId: z.string().describe("The resolved user the invite was sent to."),
    status: InviteStatus.describe("The invite's current state."),
    sessionId: z
      .string()
      .nullable()
      .describe("The multiplayer session id minted on accept, or null while pending/declined."),
    createdAt: SQLiteDate.describe("When the invite was sent."),
    respondedAt: SQLiteDate.nullable().describe("When the invitee accepted or declined, or null while pending."),
  })
  .describe("One direct invite from one player to another.");
export type Invite = z.output<typeof Invite>;
export type InviteRow = z.input<typeof Invite>;
