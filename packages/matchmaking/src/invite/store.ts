// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Invite } from "../data/invite";
import { MATCHMAKING_INVITES_TABLE, type MatchmakingDatabase } from "../data/tables";
import { MatchmakingInviteNotFoundError } from "../error/errors";

/**
 * The direct-invite store — one player's pending asks to another. Create a pending invite; the invitee
 * accepts (a session is minted and recorded) or declines. See {@link inviteStore}.
 *
 * Round-trip rule (CLAUDE.md §Data layer): read rows with `Invite.parse` (decode), write with
 * `Invite.encode` (encode). No raw epoch numbers below.
 */

/** What creating an invite needs. */
export interface CreateInviteInput {
  id: string;
  gameKey: string;
  inviterId: string;
  inviteeId: string;
  at: Date;
}

export interface InviteStore {
  /** Persist a new pending invite. */
  create(input: CreateInviteInput): Promise<Invite>;
  /** Fetch an invite by id, or undefined. */
  get(id: string): Promise<Invite | undefined>;
  /** Mark an invite accepted and record the minted session id. Throws `matchmaking/invite_not_found`. */
  accept(id: string, sessionId: string, at: Date): Promise<Invite>;
  /** Mark an invite declined. Throws `matchmaking/invite_not_found`. */
  decline(id: string, at: Date): Promise<Invite>;
  /** Every pending invite addressed to `userId`. */
  pendingFor(userId: string): Promise<Invite[]>;
}

export function inviteStore(db: MatchmakingDatabase): InviteStore {
  const get = async (id: string): Promise<Invite | undefined> => {
    const row = await db.selectFrom(MATCHMAKING_INVITES_TABLE).where("id", "=", id).selectAll().executeTakeFirst();
    return row ? Invite.parse(row) : undefined;
  };

  const loadOrThrow = async (id: string): Promise<Invite> => {
    const invite = await get(id);
    if (!invite) {
      throw new MatchmakingInviteNotFoundError({ detail: `No invite with id ${id}.` });
    }
    return invite;
  };

  return {
    async create(input: CreateInviteInput): Promise<Invite> {
      const invite: Invite = {
        id: input.id,
        gameKey: input.gameKey,
        inviterId: input.inviterId,
        inviteeId: input.inviteeId,
        status: "pending",
        sessionId: null,
        createdAt: input.at,
        respondedAt: null,
      };
      await db.insertInto(MATCHMAKING_INVITES_TABLE).values(Invite.encode(invite)).execute();
      return invite;
    },

    get,

    async accept(id: string, sessionId: string, at: Date): Promise<Invite> {
      const invite = await loadOrThrow(id);
      const updated: Invite = { ...invite, status: "accepted", sessionId, respondedAt: at };
      const record = Invite.encode(updated);
      await db
        .updateTable(MATCHMAKING_INVITES_TABLE)
        .set({ status: record.status, sessionId: record.sessionId, respondedAt: record.respondedAt })
        .where("id", "=", id)
        .execute();
      return updated;
    },

    async decline(id: string, at: Date): Promise<Invite> {
      const invite = await loadOrThrow(id);
      const updated: Invite = { ...invite, status: "declined", respondedAt: at };
      const record = Invite.encode(updated);
      await db
        .updateTable(MATCHMAKING_INVITES_TABLE)
        .set({ status: record.status, respondedAt: record.respondedAt })
        .where("id", "=", id)
        .execute();
      return updated;
    },

    async pendingFor(userId: string): Promise<Invite[]> {
      const rows = await db
        .selectFrom(MATCHMAKING_INVITES_TABLE)
        .where("inviteeId", "=", userId)
        .where("status", "=", "pending")
        .orderBy("createdAt", "desc")
        .selectAll()
        .execute();
      return rows.map((row) => Invite.parse(row));
    },
  };
}
