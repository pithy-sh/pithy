// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { decodeCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
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

/** What a management cancel did: the invite as it now stands, and whether this was a retry of one already done. */
export interface InviteCancellation {
  invite: Invite;
  replayed: boolean;
}

/** What {@link InviteStore.listPending} accepts. */
export interface PendingInvitesQuery {
  /** Restrict to one game. Already resolved against config by the handler. */
  gameKey?: string;
  /** Where to resume, from a previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped by `pageLimit`. */
  limit?: number;
}

/** One page of pending invites, newest first, and where the next one resumes. */
export interface InvitePage {
  items: Invite[];
  nextCursor: string | null;
}

export interface InviteStore {
  /** Persist a new pending invite. */
  create(input: CreateInviteInput): Promise<Invite>;
  /** Fetch an invite by id, or undefined. */
  get(id: string): Promise<Invite | undefined>;
  /**
   * Mark a pending invite accepted and record the minted session id. Throws `matchmaking/invite_not_found` for an
   * invite that is missing or no longer pending.
   */
  accept(id: string, sessionId: string, at: Date): Promise<Invite>;
  /** Mark a pending invite declined. Throws `matchmaking/invite_not_found` as `accept` does. */
  decline(id: string, at: Date): Promise<Invite>;
  /**
   * Cancel a pending invite on a management client's word, under an idempotency key. A retry of the same key on
   * the same invite is answered as a replay and changes nothing. Throws `matchmaking/invite_not_found` for an
   * invite that is missing or no longer pending, and `core/conflict` for a key already spent on another invite.
   */
  cancel(id: string, cancelKey: string, at: Date): Promise<InviteCancellation>;
  /** Every pending invite, newest first, a keyset page at a time. */
  listPending(query: PendingInvitesQuery): Promise<InvitePage>;
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
        cancelKey: null,
      };
      await db.insertInto(MATCHMAKING_INVITES_TABLE).values(Invite.encode(invite)).execute();
      return invite;
    },

    get,

    async accept(id: string, sessionId: string, at: Date): Promise<Invite> {
      const invite = await loadOrThrow(id);
      const updated: Invite = { ...invite, status: "accepted", sessionId, respondedAt: at };
      const record = Invite.encode(updated);
      const result = await db
        .updateTable(MATCHMAKING_INVITES_TABLE)
        .set({ status: record.status, sessionId: record.sessionId, respondedAt: record.respondedAt })
        .where("id", "=", id)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw notPending(id);
      return updated;
    },

    async decline(id: string, at: Date): Promise<Invite> {
      const invite = await loadOrThrow(id);
      const updated: Invite = { ...invite, status: "declined", respondedAt: at };
      const record = Invite.encode(updated);
      const result = await db
        .updateTable(MATCHMAKING_INVITES_TABLE)
        .set({ status: record.status, respondedAt: record.respondedAt })
        .where("id", "=", id)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw notPending(id);
      return updated;
    },

    async cancel(id: string, cancelKey: string, at: Date): Promise<InviteCancellation> {
      // A key already on a row is either this request again or a key reused for another invite.
      const spent = await db
        .selectFrom(MATCHMAKING_INVITES_TABLE)
        .where("cancelKey", "=", cancelKey)
        .selectAll()
        .executeTakeFirst();
      if (spent) {
        if (spent.id === id) return { invite: Invite.parse(spent), replayed: true };
        throw keyReused(id);
      }

      const invite = await loadOrThrow(id);
      const record = Invite.encode({ ...invite, status: "canceled", respondedAt: at, cancelKey });
      let updated: bigint;
      try {
        // Conditional on `pending`, so the cancel and its key land together or not at all, whatever raced it.
        const result = await db
          .updateTable(MATCHMAKING_INVITES_TABLE)
          .set({ status: record.status, respondedAt: record.respondedAt, cancelKey: record.cancelKey })
          .where("id", "=", id)
          .where("status", "=", "pending")
          .executeTakeFirst();
        updated = result.numUpdatedRows;
      } catch (error) {
        // The unique index: another invite took this key between the read above and this write.
        if (isUniqueViolation(error)) throw keyReused(id);
        throw error;
      }

      const now = await loadOrThrow(id);
      if (updated > 0n) return { invite: now, replayed: false };
      // Nothing changed. A concurrent copy of this same request may have won the row; anything else means the
      // invite was already answered.
      if (now.status === "canceled" && now.cancelKey === cancelKey) return { invite: now, replayed: true };
      throw notPending(id);
    },

    async listPending(query: PendingInvitesQuery): Promise<InvitePage> {
      const limit = pageLimit(query.limit);
      const after = pendingCursor(query.cursor);
      let selection = db
        .selectFrom(MATCHMAKING_INVITES_TABLE)
        .where("status", "=", "pending")
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1)
        .selectAll();
      if (query.gameKey !== undefined) selection = selection.where("gameKey", "=", query.gameKey);
      if (after !== undefined) {
        selection = selection.where((eb) =>
          eb.or([
            eb("createdAt", "<", after.sort),
            eb.and([eb("createdAt", "=", after.sort), eb("id", "<", after.id)]),
          ]),
        );
      }
      const rows = await selection.execute();
      return toPage(
        rows.map((row) => Invite.parse(row)),
        limit,
        (invite) => ({ sort: invite.createdAt.getTime(), id: invite.id }),
      );
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

/** An invite that exists and has already been answered — accepted, declined or canceled. */
function notPending(id: string): MatchmakingInviteNotFoundError {
  return new MatchmakingInviteNotFoundError({ detail: `Invite ${id} is no longer pending.` });
}

/** A cancel key sent before for a different invite. */
function keyReused(id: string): ConflictError {
  return new ConflictError({
    message: "That idempotency key was already used to cancel a different invite.",
    action: "Send a fresh idempotency key for each distinct cancel.",
    detail: `Cancel key reused for invite ${id}.`,
  });
}

/** D1's refusal of a write that would duplicate a unique index — its message is the only signal it gives. */
function isUniqueViolation(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.includes("UNIQUE constraint failed");
}

/**
 * Where a pending-invites page resumes: a `createdAt` ms-epoch and the invite id that breaks a tie. A cursor of any
 * other shape was not one of ours, and is a first page rather than an error.
 */
function pendingCursor(raw: string | undefined): { sort: number; id: string } | undefined {
  const cursor = decodeCursor(raw);
  if (!cursor || typeof cursor.sort !== "number" || typeof cursor.id !== "string") return undefined;
  return { sort: cursor.sort, id: cursor.id };
}
