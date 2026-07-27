import { z } from "zod";
import { MatchmakingQueueSettings, MatchmakingSnapshot } from "../config/config";

/**
 * The open-queue matching core — the pure pairing rule and the shapes the {@link MatchmakingQueue} Durable
 * Object persists. Kept here, free of any Workers runtime import, so the algorithm is unit-testable in a
 * plain Node context and the DO shell simply drives it.
 *
 * A waiting player carries their skill and region bucket plus the settings that govern how their skill band
 * widens with time. {@link formMatches} is deterministic in `(waiting, now)`: the longer a player waits, the
 * wider their acceptable opponent skill window, until — past `maxWaitSeconds` — it opens to anyone in their
 * region. Players in different regions never pair; an unrated player (`skill` null) pairs with anyone.
 */

/** One player waiting in a game's open queue — a single entry in the DO's persisted `waiting` array. */
export const WaitingTicket = z
  .object({
    userId: z.string().describe("The waiting player's authenticated user id — the roster and match key."),
    skill: z
      .number()
      .nullable()
      .describe("The player's skill number in the game's rating pool, or null when unrated (pairs with anyone)."),
    region: z.string().describe("The region bucket the player is pinned to — pairing never crosses regions."),
    players: z.number().int().describe("How many players form a match in this game — the roster size to fill."),
    snapshot: MatchmakingSnapshot.describe("How to mint the multiplayer session once this ticket's roster fills."),
    settings: MatchmakingQueueSettings.describe("The band settings that govern how this ticket's skill window widens."),
    enqueuedAt: z
      .number()
      .int()
      .describe("When the player entered the queue, ms epoch — the age its band widens from."),
  })
  .describe("A player waiting in a game's open queue.");
export type WaitingTicket = z.output<typeof WaitingTicket>;

/** The DO's persisted queue — every player currently waiting in this game. */
export const WaitingList = z.array(WaitingTicket).describe("Every player currently waiting in a game's open queue.");
export type WaitingList = z.output<typeof WaitingList>;

/** A formed match recorded per player, read once by a polling `status()` and pushed best-effort to presence. */
export const StoredMatch = z
  .object({
    sessionId: z
      .string()
      .nullable()
      .describe("The minted multiplayer session id, or null when @pithy-sh/multiplayer is not installed."),
    roster: z.array(z.string()).describe("The user ids paired into this match, creator first."),
    gameKey: z.string().describe("The game this match belongs to — carried for the presence `match_found` push."),
    at: z.number().int().describe("When the match formed, ms epoch."),
  })
  .describe("A formed match recorded for one player, delivered once on the next status read.");
export type StoredMatch = z.output<typeof StoredMatch>;

/** A single formed roster — the user ids that pair into one match. */
export interface MatchGroup {
  roster: string[];
}

/**
 * A ticket's current skill band half-width at `now`. An unrated player has no band (they pair with anyone).
 * Otherwise the band starts at `initialBand` and grows by `widenPerSecond` for every second waited, until it
 * opens without bound once the wait passes `maxWaitSeconds`.
 */
function band(ticket: WaitingTicket, now: number): number {
  if (ticket.skill === null) return Number.POSITIVE_INFINITY;
  const elapsedMs = now - ticket.enqueuedAt;
  const { initialBand, widenPerSecond, maxWaitSeconds } = ticket.settings;
  if (elapsedMs >= maxWaitSeconds * 1000) return Number.POSITIVE_INFINITY;
  return initialBand + widenPerSecond * (elapsedMs / 1000);
}

/**
 * Whether two waiting players may pair right now. Either being unrated pairs them; otherwise their skill gap
 * must fit inside the wider of the two bands — so the longer-waiting player's relaxed window carries the pair.
 */
function compatible(a: WaitingTicket, b: WaitingTicket, now: number): boolean {
  if (a.skill === null || b.skill === null) return true;
  return Math.abs(a.skill - b.skill) <= Math.max(band(a, now), band(b, now));
}

/**
 * Form as many full rosters as the waiting set allows at `now`. Pure and deterministic. Players are bucketed
 * by region (a pair never crosses regions); within a bucket the oldest waiter anchors a roster — its band is
 * widest — and compatible others (in wait order) fill it to `players`. A roster that cannot fill leaves its
 * anchor waiting; the sweep alarm retries later with a wider band.
 */
export function formMatches(waiting: WaitingTicket[], now: number): MatchGroup[] {
  const results: MatchGroup[] = [];

  const byRegion = new Map<string, WaitingTicket[]>();
  for (const ticket of waiting) {
    const bucket = byRegion.get(ticket.region);
    if (bucket) bucket.push(ticket);
    else byRegion.set(ticket.region, [ticket]);
  }

  for (const bucket of byRegion.values()) {
    let pool = [...bucket].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    while (pool.length > 0) {
      const anchor = pool[0];
      if (!anchor) break;
      const need = anchor.players;
      const roster: WaitingTicket[] = [anchor];
      for (let i = 1; i < pool.length && roster.length < need; i++) {
        const candidate = pool[i];
        // Compatible with EVERY current roster member, not just the anchor — so an N-player roster never
        // seats two members whose skills exceed each other's band.
        if (candidate && roster.every((member) => compatible(member, candidate, now))) roster.push(candidate);
      }
      if (roster.length === need) {
        results.push({ roster: roster.map((ticket) => ticket.userId) });
        const chosen = new Set(roster);
        pool = pool.filter((ticket) => !chosen.has(ticket));
      } else {
        // The oldest waiter cannot fill a roster yet — leave it and try the next.
        pool = pool.slice(1);
      }
    }
  }

  return results;
}
