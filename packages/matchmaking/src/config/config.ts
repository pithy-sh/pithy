import { z } from "zod";

/**
 * The matchmaking capability's config — the thin, user-owned surface in `pithy.config.ts`. Every field is
 * `.describe()`d (CLAUDE.md §Config). A game declares how many players form a match, an optional
 * `@pithy-sh/rating` pool to bucket the open queue on, and the `snapshot` used to mint the
 * `@pithy-sh/multiplayer` session a match resolves into. Room codes, the queue, and abuse protection are
 * configured per game and per capability.
 */

/** A game key is a URL path segment, so it is kebab-case and lowercase. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The minimal multiplayer `GameSnapshot` matchmaking needs to mint a session when a match forms. */
export const MatchmakingSnapshot = z
  .object({
    kind: z
      .string()
      .min(1)
      .describe("The multiplayer game-model kind the session runs — a `kind` registered in @pithy-sh/multiplayer."),
    mode: z
      .enum(["match", "table"])
      .default("match")
      .describe("The multiplayer session lifecycle — a one-off `match` or a long-lived `table`."),
    turnTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .nullable()
      .default(null)
      .describe("The session's per-turn deadline in ms, or null for no deadline. Passed through to the session."),
    rules: z
      .unknown()
      .describe("The multiplayer game-model's `rules` block, passed through to the minted session unchanged."),
  })
  .describe("How to mint the multiplayer session a formed match resolves into.");
export type MatchmakingSnapshot = z.output<typeof MatchmakingSnapshot>;

/** Room-code settings — the zero-discovery, play-with-a-friend path. */
export const MatchmakingRoomCodes = z
  .object({
    enabled: z.boolean().default(true).describe("Whether a host may open a room and share a join code."),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .default(900)
      .describe("How long a room code stays valid, in seconds (KV TTL; floor 60). Default 15 minutes."),
    maxUses: z
      .number()
      .int()
      .positive()
      .default(9)
      .describe("How many times a code may be redeemed before it is spent — bounds abuse of a shared code."),
  })
  .describe("Room-code settings: a short, shareable, short-lived, limited-use join code.");
export type MatchmakingRoomCodes = z.output<typeof MatchmakingRoomCodes>;

/** Open-queue settings — the skill/region-bucketed pairing coordinator. */
export const MatchmakingQueueSettings = z
  .object({
    enabled: z.boolean().default(true).describe("Whether players may enqueue for open matchmaking in this game."),
    initialBand: z
      .number()
      .nonnegative()
      .default(100)
      .describe(
        "The initial skill band half-width — a waiting player first matches only others within ±band of their skill.",
      ),
    widenPerSecond: z
      .number()
      .nonnegative()
      .default(50)
      .describe(
        "How much the skill band widens for every second a player waits — relaxes the match the longer they wait.",
      ),
    maxWaitSeconds: z
      .number()
      .int()
      .positive()
      .default(120)
      .describe(
        "After this wait the band is unbounded — the player matches any available opponent in their region bucket.",
      ),
    sweepSeconds: z
      .number()
      .int()
      .positive()
      .default(5)
      .describe("How often, in seconds, the coordinator re-attempts pairing and widens bands (its alarm cadence)."),
  })
  .describe("Open-queue pairing settings: how the skill band starts and widens over time.");
export type MatchmakingQueueSettings = z.output<typeof MatchmakingQueueSettings>;

export const MatchmakingGame = z
  .object({
    key: z
      .string()
      .regex(KEY_PATTERN, "A game key is lowercase, digits, and dashes — it is a URL path segment.")
      .describe("The game's stable id, unique across the app. A URL path segment."),
    players: z.number().int().min(2).default(2).describe("How many players form a match in this game (default 2)."),
    skillPool: z
      .string()
      .optional()
      .describe(
        "The @pithy-sh/rating pool to bucket the open queue on. Omit to bucket by region only (no skill matching).",
      ),
    snapshot: MatchmakingSnapshot.describe("How the multiplayer session is minted when a match forms."),
    roomCodes: MatchmakingRoomCodes.prefault({}).describe("Room-code settings for this game."),
    queue: MatchmakingQueueSettings.prefault({}).describe("Open-queue settings for this game."),
  })
  .describe("One matchmaking game: its roster size, skill pool, session snapshot, and pairing settings.");
export type MatchmakingGame = z.output<typeof MatchmakingGame>;

/** Room-code join abuse protection — opt-in, off by default. */
export const MatchmakingAbuse = z
  .object({
    turnstile: z
      .boolean()
      .default(false)
      .describe("Gate room-code join with a Turnstile humanity check (needs @pithy-sh/turnstile). Off by default."),
    rateLimit: z.boolean().default(false).describe("Rate-limit room-code join attempts per user. Off by default."),
  })
  .describe("Opt-in abuse protection for room-code join.");
export type MatchmakingAbuse = z.output<typeof MatchmakingAbuse>;

export const MatchmakingConfig = z
  .object({
    games: z
      .array(MatchmakingGame)
      .min(1, "A matchmaking capability needs at least one game — configure at least one.")
      .describe("The matchmaking games. Each declares its roster, skill pool, and session snapshot."),
    friends: z.boolean().default(true).describe("Whether the friend graph (requests, accepts, removal) is enabled."),
    abuse: MatchmakingAbuse.prefault({}).describe("Room-code join abuse protection (off by default)."),
  })
  .describe("The matchmaking capability's configuration.")
  .check((ctx) => {
    const seen = new Set<string>();
    for (const game of ctx.value.games) {
      if (seen.has(game.key)) {
        ctx.issues.push({
          code: "custom",
          input: game.key,
          path: ["games"],
          message: `Duplicate game key "${game.key}" — each game key must be unique.`,
        });
      }
      seen.add(game.key);
    }
  });
export type MatchmakingConfig = z.output<typeof MatchmakingConfig>;
export type MatchmakingConfigInput = z.input<typeof MatchmakingConfig>;

/** The configured game for a key, or undefined. */
export function resolveGame(config: MatchmakingConfig, key: string): MatchmakingGame | undefined {
  return config.games.find((g) => g.key === key);
}
