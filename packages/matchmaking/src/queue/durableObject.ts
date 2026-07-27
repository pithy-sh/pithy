import { DurableObject } from "cloudflare:workers";
import type { MatchmakingQueueSettings, MatchmakingSnapshot } from "../config/config";
import { MatchmakingNotQueuedError } from "../error/errors";
import { guardRpc } from "../rpc";
import { type SessionNamespace, sessionMinter } from "../session/minter";
import { formMatches, StoredMatch, WaitingList, type WaitingTicket } from "./matching";

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

/** The minimal presence RPC the coordinator pushes to — declared locally so the queue never imports it. */
interface PresenceStub {
  notify(userId: string, event: { type: "match_found"; sessionId: string; gameKey: string }): Promise<void>;
}

const WAITING_KEY = "waiting";
const GAME_KEY = "gameKey";
const PRESENCE_NAME = "presence";

const matchKey = (userId: string): string => `match:${userId}`;

export class MatchmakingQueue extends DurableObject<MatchmakingQueueEnv> {
  /** Add a player to the queue and attempt an immediate match. */
  async enqueue(ticket: QueueTicket): Promise<QueueStatus> {
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
    const waiting = await this.readWaiting();
    const remaining = waiting.filter((t) => t.userId !== userId);
    if (remaining.length === waiting.length) return;
    await this.ctx.storage.put(WAITING_KEY, remaining);
    if (remaining.length === 0) await this.ctx.storage.deleteAlarm();
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
