import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { FriendStatus } from "../data/friend";
import { Friendship } from "../data/friend";
import { MATCHMAKING_FRIENDS_TABLE, type MatchmakingDatabase } from "../data/tables";
import { MatchmakingAlreadyFriendsError, MatchmakingFriendRequestNotFoundError } from "../error/errors";

/**
 * The friend graph — a symmetric connection formed by mutual accept. A player sends a request; the
 * recipient accepts (forming the edge) or declines (dropping it); either party can later remove an
 * accepted edge. Pairs are canonicalized (`userA < userB`) so a connection is one row regardless of who
 * asked. See {@link friendStore}.
 */

/** One friend edge from a given user's perspective. */
export interface FriendSummary {
  /** The other user in the edge. */
  userId: string;
  /** Whether the edge is a pending request or an accepted friendship. */
  status: FriendStatus;
  /** For a pending edge: `outgoing` (this user asked) or `incoming` (the other asked). `mutual` once accepted. */
  direction: "incoming" | "outgoing" | "mutual";
  /** When the edge was last updated. */
  since: Date;
}

export interface FriendStore {
  /** Send a friend request from `from` to `to`. Throws `matchmaking/already_friends` if an edge exists. */
  request(from: string, to: string, at: Date): Promise<void>;
  /** `userId` accepts a pending request from `other`. Throws `matchmaking/friend_request_not_found` if none. */
  accept(userId: string, other: string, at: Date): Promise<void>;
  /** `userId` declines/withdraws a pending edge with `other` (drops the row). */
  decline(userId: string, other: string): Promise<void>;
  /** `userId` removes an accepted friendship with `other`. */
  remove(userId: string, other: string): Promise<void>;
  /** Every edge touching `userId`, from their perspective. */
  list(userId: string): Promise<FriendSummary[]>;
  /** Whether `a` and `b` are accepted friends. */
  areFriends(a: string, b: string): Promise<boolean>;
}

/** Order a pair so the row is stored once regardless of who asked: `userA` is the lexicographically smaller id. */
function canonical(x: string, y: string): { userA: string; userB: string } {
  return x < y ? { userA: x, userB: y } : { userA: y, userB: x };
}

export function friendStore(db: MatchmakingDatabase): FriendStore {
  const findPair = (userA: string, userB: string) =>
    db
      .selectFrom(MATCHMAKING_FRIENDS_TABLE)
      .selectAll()
      .where("userA", "=", userA)
      .where("userB", "=", userB)
      .executeTakeFirst();

  return {
    async request(from, to, at) {
      if (from === to) {
        throw new ValidationError({
          message: "You cannot send a friend request to yourself.",
          detail: `request called with from === to (${from}).`,
        });
      }
      const { userA, userB } = canonical(from, to);
      const existing = await findPair(userA, userB);
      if (existing) {
        throw new MatchmakingAlreadyFriendsError({
          detail: `A friend edge already exists for (${userA}, ${userB}) with status ${String((existing as { status: unknown }).status)}.`,
        });
      }
      const record = {
        userA,
        userB,
        status: "pending" as const,
        requestedBy: from,
        createdAt: Friendship.shape.createdAt.encode(at),
        updatedAt: Friendship.shape.updatedAt.encode(at),
      };
      await db
        .insertInto(MATCHMAKING_FRIENDS_TABLE)
        // biome-ignore lint/suspicious/noExplicitAny: the record is the schema's `z.input` side; `id` is an autoincrement rowid SQLite assigns.
        .values(record as any)
        .execute();
    },

    async accept(userId, other, at) {
      const { userA, userB } = canonical(userId, other);
      const row = await findPair(userA, userB);
      const parsed = row ? Friendship.parse(row) : undefined;
      if (!parsed || parsed.status !== "pending" || parsed.requestedBy !== other) {
        throw new MatchmakingFriendRequestNotFoundError({
          detail: `No pending request from ${other} to ${userId} to accept.`,
        });
      }
      await db
        .updateTable(MATCHMAKING_FRIENDS_TABLE)
        .set({ status: "accepted", updatedAt: Friendship.shape.updatedAt.encode(at) })
        .where("userA", "=", userA)
        .where("userB", "=", userB)
        .execute();
    },

    async decline(userId, other) {
      const { userA, userB } = canonical(userId, other);
      await db
        .deleteFrom(MATCHMAKING_FRIENDS_TABLE)
        .where("userA", "=", userA)
        .where("userB", "=", userB)
        .where("status", "=", "pending")
        .execute();
    },

    async remove(userId, other) {
      const { userA, userB } = canonical(userId, other);
      await db.deleteFrom(MATCHMAKING_FRIENDS_TABLE).where("userA", "=", userA).where("userB", "=", userB).execute();
    },

    async list(userId) {
      const rows = await db
        .selectFrom(MATCHMAKING_FRIENDS_TABLE)
        .selectAll()
        .where((eb) => eb.or([eb("userA", "=", userId), eb("userB", "=", userId)]))
        .execute();
      return rows.map((row) => {
        const edge = Friendship.parse(row);
        const otherId = edge.userA === userId ? edge.userB : edge.userA;
        const direction = edge.status === "accepted" ? "mutual" : edge.requestedBy === userId ? "outgoing" : "incoming";
        return { userId: otherId, status: edge.status, direction, since: edge.updatedAt };
      });
    },

    async areFriends(a, b) {
      const { userA, userB } = canonical(a, b);
      const row = await db
        .selectFrom(MATCHMAKING_FRIENDS_TABLE)
        .select("id")
        .where("userA", "=", userA)
        .where("userB", "=", userB)
        .where("status", "=", "accepted")
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
