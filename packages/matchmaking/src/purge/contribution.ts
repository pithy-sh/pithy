// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { personRowsPurge } from "@pithy-sh/core/src/capability/personRows";
import { type ErasingPurgeContribution, type PurgeContext, purgeBinding } from "@pithy-sh/core/src/capability/purge";
import { Friendship } from "../data/friend";
import { Invite } from "../data/invite";
import { MATCHMAKING_FRIENDS_TABLE, MATCHMAKING_INVITES_TABLE } from "../data/tables";
import type { MatchmakingQueue } from "../queue/durableObject";
import type { QueueHolding } from "../queue/matching";

/**
 * What erasing one person means for `@pithy-sh/matchmaking` (#814): every invite they sent or were sent, and every
 * friendship or request they are either side of — and what exporting them hands back.
 *
 * **Both sides are theirs.** An invite names an inviter and an invitee, a friendship two users; a row is the
 * person's when either column is. Deleting it leaves the other person one invite or one friend fewer, which is what
 * a friendship with an erased account means.
 *
 * **Not the operator's key.** An invite a management client canceled carries the idempotency key it was canceled with
 * (#819). That key is the operator's request, not the person's data, so the export leaves it out; the audit trail
 * keeps the cancel with its actor.
 *
 * **And each game's queue.** A queue is a Durable Object per configured game, and it holds a waiting player's ticket,
 * a match formed for them that they have not polled for yet, and a day of management drops naming them. None of it
 * expires by itself — a lone player can wait indefinitely, and an undelivered match waits for its poll — so the step
 * asks every game's queue what it holds about the person, and then to forget it. A queue that holds nothing is left
 * out of the export.
 *
 * **What is not here, and why.** A room code in KV names its host, and it is gone on its own TTL — fifteen minutes by
 * default — so it never outlives a deletion's window.
 */

/** The one sentence the purge records with this step. */
export const MATCHMAKING_PURGE_SUMMARY =
  "Deletes every game invite the user sent or received, every friendship and friend request on either side, and their place, undelivered match and drop records in every game's queue.";

/** What one game's queue holds about the person, under the game it is for. */
type QueueEntry = { gameKey: string } & QueueHolding;

/** Whether a queue holds anything about the person. */
function holdsAnything(held: QueueHolding): boolean {
  return held.waiting !== null || held.match !== null || held.drops.length > 0;
}

/**
 * The user contribution `matchmaking()` declares, over the D1 binding its tables live in and the configured games,
 * whose queues it reaches through the `QUEUE` Durable Object binding.
 */
export function matchmakingUserPurge(database = "DB", gameKeys: readonly string[] = []): ErasingPurgeContribution {
  const rows = personRowsPurge({
    capability: "matchmaking",
    summary: MATCHMAKING_PURGE_SUMMARY,
    database,
    tables: [
      {
        table: MATCHMAKING_INVITES_TABLE,
        schema: Invite,
        columns: ["inviterId", "inviteeId"],
        as: "invites",
        orderBy: "createdAt",
        omit: ["cancelKey"],
      },
      {
        table: MATCHMAKING_FRIENDS_TABLE,
        schema: Friendship,
        columns: ["userA", "userB"],
        as: "friends",
        orderBy: "id",
      },
    ],
  });
  /** Every configured game's queue, or none — read off the env only when there is a game to reach. */
  const queues = ({ env }: PurgeContext) => {
    if (gameKeys.length === 0) return [];
    const namespace = purgeBinding<DurableObjectNamespace<MatchmakingQueue>>(
      env,
      "QUEUE",
      "matchmaking",
      "Durable Object namespace",
    );
    return gameKeys.map((gameKey) => ({ gameKey, stub: namespace.get(namespace.idFromName(gameKey)) }));
  };
  return {
    ...rows,
    erase: async (context) => {
      // The binding is resolved before anything is deleted, so a Worker missing it fails the step whole.
      const reached = queues(context);
      await rows.erase(context);
      for (const { stub } of reached) await stub.forget(context.subject.id);
    },
    export: async (context) => {
      const reached = queues(context);
      const data = rows.export ? await rows.export(context) : {};
      const held: QueueEntry[] = [];
      for (const { gameKey, stub } of reached) {
        const holding = (await stub.heldFor(context.subject.id)) as QueueHolding;
        if (holdsAnything(holding)) held.push({ gameKey, ...holding });
      }
      return { ...data, queues: held };
    },
  };
}
