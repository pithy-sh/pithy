// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DurableObject } from "cloudflare:workers";
import type { D1Database, DurableObjectNamespace } from "@cloudflare/workers-types";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import type { MatchmakingQueueSettings, MatchmakingSnapshot } from "../config/config";
import { MatchmakingNotQueuedError } from "../error/errors";
import type { PresenceMatchFoundFrame } from "../presence/frames";
import { guardRpc } from "../rpc";
import { type SessionNamespace, sessionMinter } from "../session/minter";
import {
  type DropOutcome,
  DropRecord,
  formMatches,
  StoredMatch,
  skillBand,
  type WaitingEntry,
  WaitingList,
  type WaitingTicket,
} from "./matching";

/**
 * The open-queue coordinator — one Durable Object per game (addressed `env.QUEUE.idFromName(gameKey)`).
 * Players enqueue with their skill and region bucket; the DO pairs them, minting a multiplayer session
 * when a full roster forms. An alarm sweeps on a cadence, widening each waiting player's skill band the
 * longer they wait, so a long wait relaxes into any-opponent. Matches are recorded per user for a polling
 * `status()` read, and pushed best-effort to the presence DO.
 *
 * Platform discipline (mirrors the multiplayer session DO): storage is read fresh and Zod-parsed in every
 * handler (no in-memory cache to survive eviction); the sweep is a single persisted alarm at an absolute
 * ms-epoch time (never a timer); and the alarm handler is idempotent (an empty queue clears the alarm and
 * no-ops). `Date.now()` is used inside handlers — permitted in the Workers runtime.
 */
export interface MatchmakingQueueEnv {
  DB: D1Database;
  SESSIONS?: DurableObjectNamespace;
  PRESENCE?: DurableObjectNamespace;
}

/** A player's entry into the queue — everything the coordinator needs to bucket and later mint. */
export interface QueueTicket {
  userId: string;
  skill: number | null;
  region: string;
  gameKey: string;
  players: number;
  settings: MatchmakingQueueSettings;
  snapshot: MatchmakingSnapshot;
}

/** A player's standing in the queue. */
export interface QueueStatus {
  state: "queued" | "matched";
  sessionId: string | null;
  waitingMs: number;
}

/**
 * The minimal presence RPC the coordinator pushes to — declared locally so the queue never imports the presence
 * Durable Object. The frame it pushes is the presence socket's own `match_found` schema.
 */
interface PresenceStub {
  notify(userId: string, event: PresenceMatchFoundFrame): Promise<void>;
}

const WAITING_KEY = "waiting";
const GAME_KEY = "gameKey";
const PRESENCE_NAME = "presence";

const matchKey = (userId: string): string => `match:${userId}`;
const dropKey = (idempotencyKey: string): string => `drop:${idempotencyKey}`;

/**
 * How long a management drop's idempotency key is remembered. A retry arrives in seconds; a day is far past
 * any client's retry window, and it keeps the record from growing for the life of the game.
 */
const DROP_KEY_RETENTION_MS = 24 * 60 * 60 * 1000;

export class MatchmakingQueue extends DurableObject<MatchmakingQueueEnv> {
  /**
   * The tail of the queue's mutation chain. A Durable Object's input gate holds new calls only while a storage
   * operation is pending, never across an outgoing RPC — so while a sweep awaits a session mint, a `drop` or a
   * `leave` could run in full, and the sweep would then write back the waiting list it read before the mint,
   * putting the dropped player back. Every method that rewrites the waiting list runs through `serialize`, one
   * after another, so each reads the list the last one wrote. In memory on purpose: an evicted object has no
   * call in flight to wait for.
   */
  private mutations: Promise<unknown> = Promise.resolve();

  /** Run `work` after every earlier mutation has settled, whether it succeeded or threw. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutations.then(work, work);
    this.mutations = run.catch(() => undefined);
    return run;
  }

  /** Add a player to the queue and attempt an immediate match. */
  async enqueue(ticket: QueueTicket): Promise<QueueStatus> {
    return this.serialize(() => this.enqueueNow(ticket));
  }

  private async enqueueNow(ticket: QueueTicket): Promise<QueueStatus> {
    const now = Date.now();

    // A match already waiting for this player wins — return it (status delivers-once, so don't clear here).
    const existing = await this.readMatch(ticket.userId);
    if (existing) return { state: "matched", sessionId: existing.sessionId, waitingMs: 0 };

    // Remember this coordinator's game for the alarm's later match records and presence pushes.
    await this.ctx.storage.put(GAME_KEY, ticket.gameKey);

    // Upsert the waiting entry with a fresh wait clock.
    const waiting = (await this.readWaiting()).filter((t) => t.userId !== ticket.userId);
    waiting.push({
      userId: ticket.userId,
      skill: ticket.skill,
      region: ticket.region,
      players: ticket.players,
      snapshot: ticket.snapshot,
      settings: ticket.settings,
      enqueuedAt: now,
    });

    const { matched, remaining } = await this.applyMatches(waiting, now);
    await this.reconcileAlarm(remaining, now);

    const mine = matched.get(ticket.userId);
    // The enqueue response reports the match as a convenience; the stored copy stays so a client that polls
    // status() instead still receives it (status is the deliver-once channel). A join is idempotent, so a
    // client that reads both channels simply joins the same session twice with no ill effect.
    if (mine) return { state: "matched", sessionId: mine.sessionId, waitingMs: 0 };
    return { state: "queued", sessionId: null, waitingMs: 0 };
  }

  /** Remove a player from the queue. */
  async leave(userId: string): Promise<void> {
    return this.serialize(async () => {
      const waiting = await this.readWaiting();
      const remaining = waiting.filter((t) => t.userId !== userId);
      if (remaining.length === waiting.length) return;
      await this.ctx.storage.put(WAITING_KEY, remaining);
      if (remaining.length === 0) await this.ctx.storage.deleteAlarm();
    });
  }

  /**
   * Everyone waiting, oldest first, as a management client reads the queue: region, skill, the band the next
   * sweep would use, and when they joined. Read from the coordinator's own storage, never a copy.
   */
  async waiting(): Promise<WaitingEntry[]> {
    const now = Date.now();
    return (await this.readWaiting())
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      .map((ticket) => ({
        userId: ticket.userId,
        region: ticket.region,
        skill: ticket.skill,
        skillBand: skillBand(ticket, now),
        enqueuedAt: ticket.enqueuedAt,
      }));
  }

  /**
   * Drop a player from the queue, on a management client's word, under an idempotency key.
   *
   * **Idempotent by the key, and atomic because it is serialized with every other mutation.** A drop that lands
   * while a sweep is minting waits for that sweep, so it reads the list the sweep wrote: a player the sweep paired
   * is `matchmaking/not_queued`, and a player it left waiting stays dropped. The key is recorded beside the
   * removal, so a retry of the same request finds the record and answers `replayed`, changing nothing. A key
   * already spent on another player is refused rather than read as a replay — it is a client bug, and answering
   * it as success would tell an operator a player was dropped who was not. A player who is not waiting is
   * `matchmaking/not_queued`, and the key is left unspent.
   */
  async drop(userId: string, idempotencyKey: string): Promise<DropOutcome> {
    return guardRpc(() => this.serialize(() => this.dropNow(userId, idempotencyKey)));
  }

  private async dropNow(userId: string, idempotencyKey: string): Promise<DropOutcome> {
    const now = Date.now();
    const recorded = await this.ctx.storage.get(dropKey(idempotencyKey));
    if (recorded !== undefined) {
      const record = DropRecord.parse(recorded);
      if (record.userId === userId) return { replayed: true };
      throw new ConflictError({
        message: "That idempotency key was already used to drop a different player.",
        action: "Send a fresh idempotency key for each distinct drop.",
        detail: `Drop key reused: recorded for another player, now sent for ${userId}.`,
      });
    }

    const waiting = await this.readWaiting();
    const remaining = waiting.filter((t) => t.userId !== userId);
    if (remaining.length === waiting.length) {
      throw new MatchmakingNotQueuedError({
        message: "That player is not in this queue.",
        detail: `User ${userId} is not queued for this game.`,
      });
    }

    await this.ctx.storage.put(WAITING_KEY, remaining);
    await this.ctx.storage.put(dropKey(idempotencyKey), { userId, at: now } satisfies DropRecord);
    if (remaining.length === 0) await this.ctx.storage.deleteAlarm();
    await this.pruneDropKeys(now);
    return { replayed: false };
  }

  /** A player's current standing — returns and clears a match once found. */
  async status(userId: string): Promise<QueueStatus> {
    // guardRpc encodes the not-queued PithyError so its 404 survives the DO RPC boundary (else it 500s).
    return guardRpc(async () => {
      const match = await this.readMatch(userId);
      if (match) {
        // Deliver-once: hand back the match and drop it so a re-poll reflects the (now empty) standing.
        await this.ctx.storage.delete(matchKey(userId));
        return { state: "matched", sessionId: match.sessionId, waitingMs: 0 };
      }
      const mine = (await this.readWaiting()).find((t) => t.userId === userId);
      if (mine) return { state: "queued", sessionId: null, waitingMs: Date.now() - mine.enqueuedAt };
      throw new MatchmakingNotQueuedError({ detail: `User ${userId} is not queued for this game.` });
    });
  }

  /** The sweep: re-attempt pairing with bands widened by elapsed wait, mint and record any formed rosters. */
  override async alarm(): Promise<void> {
    return this.serialize(() => this.sweep());
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const waiting = await this.readWaiting();
    if (waiting.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const { remaining } = await this.applyMatches(waiting, now);
    await this.reconcileAlarm(remaining, now);
  }

  // --- internals ---

  /** The waiting queue, read fresh and validated. Empty when nothing is stored. */
  private async readWaiting(): Promise<WaitingTicket[]> {
    const raw = await this.ctx.storage.get(WAITING_KEY);
    return raw === undefined ? [] : WaitingList.parse(raw);
  }

  /** This player's recorded match, read fresh and validated, or undefined. */
  private async readMatch(userId: string): Promise<StoredMatch | undefined> {
    const raw = await this.ctx.storage.get(matchKey(userId));
    return raw === undefined ? undefined : StoredMatch.parse(raw);
  }

  private async readGameKey(): Promise<string> {
    const raw = await this.ctx.storage.get(GAME_KEY);
    return typeof raw === "string" ? raw : "";
  }

  /**
   * Run the pairing rule over `waiting`, mint a session per formed roster (or null when `SESSIONS` is not
   * bound), record each matched player's result, and persist the players left waiting. Presence is always
   * pushed best-effort for a match that minted a session — whether it formed on enqueue or on the sweep —
   * so a waiting player is notified in real time in the common two-player case, not only by polling.
   */
  private async applyMatches(
    waiting: WaitingTicket[],
    now: number,
  ): Promise<{ matched: Map<string, StoredMatch>; remaining: WaitingTicket[] }> {
    const gameKey = await this.readGameKey();
    const matched = new Map<string, StoredMatch>();

    for (const { roster } of formMatches(waiting, now)) {
      const anchor = waiting.find((t) => t.userId === roster[0]);
      if (!anchor) continue;
      const sessionId = this.env.SESSIONS
        ? await sessionMinter(this.env.SESSIONS as unknown as SessionNamespace).mint(
            anchor.snapshot,
            anchor.players,
            roster,
          )
        : null;
      const record: StoredMatch = { sessionId, roster: [...roster], gameKey, at: now };
      for (const uid of roster) matched.set(uid, record);
    }

    const remaining = waiting.filter((t) => !matched.has(t.userId));
    for (const [uid, record] of matched) await this.ctx.storage.put(matchKey(uid), record);
    await this.ctx.storage.put(WAITING_KEY, remaining);
    await this.pushPresence(matched);

    return { matched, remaining };
  }

  /** Push each newly matched player a `match_found` event — best-effort, never fatal, only if presence is bound. */
  private async pushPresence(matched: Map<string, StoredMatch>): Promise<void> {
    const presence = this.env.PRESENCE;
    if (!presence) return;
    const stub = presence.get(presence.idFromName(PRESENCE_NAME)) as unknown as PresenceStub;
    for (const [uid, record] of matched) {
      if (!record.sessionId) continue;
      try {
        await stub.notify(uid, { type: "match_found", sessionId: record.sessionId, gameKey: record.gameKey });
      } catch {
        // A notification never fails the match that formed it — the result is already recorded for polling.
      }
    }
  }

  /** Forget drop keys older than the retention window, so the record stays the size of a day's moderation. */
  private async pruneDropKeys(now: number): Promise<void> {
    const records = await this.ctx.storage.list({ prefix: "drop:" });
    const stale: string[] = [];
    for (const [key, value] of records) {
      const parsed = DropRecord.safeParse(value);
      if (!parsed.success || now - parsed.data.at > DROP_KEY_RETENTION_MS) stale.push(key);
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  /** Keep a single sweep alarm armed while anyone is waiting; clear it once the queue drains. */
  private async reconcileAlarm(remaining: WaitingTicket[], now: number): Promise<void> {
    const first = remaining[0];
    if (first) {
      await this.ctx.storage.setAlarm(now + first.settings.sweepSeconds * 1000);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}
