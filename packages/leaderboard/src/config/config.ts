import { z } from "zod";
import { assertValidSchedule } from "../window/schedule";

/**
 * The leaderboard capability's config — the thin, user-owned surface in `pithy.config.ts`. Every field
 * is `.describe()`d: the descriptions feed the self-documenting CLI, so a non-expert can pick the right
 * board shape and the right `rank` mode from the CLI's questions alone (CLAUDE.md §Config).
 *
 * A board definition is the unit of config. There is no boards table to administer and no dashboard to
 * click through — the board set is code, reviewed and deployed like the rest of the app. What the
 * database records is only what config cannot: the entries, and a fingerprint of each board's immutable
 * fields so a later edit cannot silently reinterpret scores already stored (see `data/boardRecord`).
 */

/** A board key is a URL path segment (`/leaderboard/<key>/top`), so it is kebab-case and lowercase. */
export const BOARD_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const ScoreDirection = z
  .enum(["asc", "desc"])
  .describe(
    "Which way a score sorts: `desc` = highest wins (points, distance), `asc` = lowest wins (lap time, strokes). Immutable after the board records its first entry — every vendor surveyed treats it that way, and flipping it would silently reinterpret every stored score.",
  );
export type ScoreDirection = z.infer<typeof ScoreDirection>;

export const ScoreAggregation = z
  .enum(["best", "latest", "sum"])
  .describe(
    "How repeat submissions combine into one entry: `best` keeps the best score in the board's direction, `latest` overwrites, `sum` accumulates. Orthogonal to direction — only `best` reads it.",
  );
export type ScoreAggregation = z.infer<typeof ScoreAggregation>;

export const LeaderboardStore = z
  .literal("d1")
  .describe(
    "Which backing store ranks this board. Today the only value is `d1`: exact ranking on your own D1, the store this whole capability is built on. It is a per-board discriminant on purpose — the issue settled `Store: D1, always` against a Durable-Object *engine* flag (a DO fixes neither cost nor throughput), but a future column-oriented store is a different axis: an Analytics-Engine-shaped board would be far cheaper at scale yet *approximate* (it samples on read and write), so it can only ever back a separate, opt-in `approximate` board type — never replace exact `d1` ranking. This field is the seam that would let such a board live beside a `d1` one, chosen per board. It is immutable once a board records entries: there is no safe automatic migration of scores between stores.",
  );
export type LeaderboardStore = z.infer<typeof LeaderboardStore>;

export const LeaderboardTier = z
  .object({
    key: z
      .string()
      .min(1)
      .describe("The tier's name as returned to clients — `gold`, `diamond`, whatever your game calls it."),
    from: z
      .number()
      .describe(
        "The score at which this tier begins, inclusive. Read in the board's direction: on a `desc` board a score at or above `from` qualifies; on an `asc` board a score at or below it does.",
      ),
  })
  .describe("One tier threshold — a named band of scores, classified on read.");
export type LeaderboardTier = z.infer<typeof LeaderboardTier>;

export const LeaderboardBoard = z
  .object({
    key: z
      .string()
      .regex(BOARD_KEY_PATTERN, "A board key is lowercase, digits, and dashes — it is a URL path segment.")
      .describe("The board's stable id, unique across the app. It is a URL path segment and an entry key."),
    store: LeaderboardStore.default("d1").describe("Which backing store ranks this board. Only `d1` today."),
    direction: ScoreDirection.describe("Which way this board's scores sort. Required — there is no safe default."),
    aggregation: ScoreAggregation.default("best").describe(
      "How this board folds repeat submissions from the same player in the same window.",
    ),
    window: z
      .string()
      .optional()
      .describe(
        "A UTC CRON expression marking where each window opens; omit for one all-time board. `0 0 * * *` is daily, `0 0 * * 1` weekly, `0 0 1 * *` a calendar month, `0 0 1 1 *` a calendar year. CRON rather than a fixed enum is what makes calendar months and years expressible at all — Apple caps recurrence at 30 fixed days and Google offers no monthly.",
      ),
    retain: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'How many closed windows to keep before the retention sweep deletes the rest — a *product* limit ("users can browse the last 12 weeks"). Omit to keep every window forever, which is the default: storage is never the cost driver here (see docs/costs.md), so nothing is deleted unless you ask. Ignored on an all-time board, which never closes a window. Set this OR `retainDays`, not both.',
      ),
    retainDays: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Delete windows whose data is older than this many days — a *compliance* limit ("nothing older than 90 days"), independent of window cadence. Omit to keep everything (the default). Ignored on an all-time board, whose single window has no age. Set this OR `retain`, not both.',
      ),
    min: z
      .number()
      .optional()
      .describe(
        "The lowest score this board will accept. Server-side bounds are the anti-cheat baseline: a client that posts outside them is rejected, not ranked.",
      ),
    max: z.number().optional().describe("The highest score this board will accept."),
    tiers: z
      .array(LeaderboardTier)
      .optional()
      .describe(
        "Named score bands, listed worst to best. Classified on read from the score already stored — a tier costs nothing on write and no second board.",
      ),
    trackActivity: z
      .boolean()
      .default(false)
      .describe(
        "Whether every submission is written, or only ones that change the ranked score. Default `false`: on a `best` board a submission that fails to beat the stored score writes *nothing* — zero rows billed — because the guard skips it. That is the single biggest cost lever this capability has, since submission writes dominate the bill and most submissions do not improve a player's best (see docs/costs.md). The cost is that `submittedAt` then advances only on an improving submission, so it stops being a record of *activity* and becomes a record of *progress*. Set `true` to write on every submission and keep `submittedAt` a true last-seen timestamp — at full write cost. Ignored on `sum` and `latest` boards, where every submission changes the score and therefore always writes.",
      ),
  })
  .describe("One board definition — the unit of leaderboard config.")
  .check((ctx) => {
    const { min, max, window, tiers, direction, retain, retainDays } = ctx.value;
    if (min !== undefined && max !== undefined && min > max) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["min"],
        message: `Board "${ctx.value.key}" sets min ${min} above max ${max}, so every score would be rejected.`,
      });
    }
    if (retain !== undefined && retainDays !== undefined) {
      // Both would need a union-or-intersection rule that the product ("keep N windows") and the
      // compliance ("delete after N days") intents pull in opposite directions on. Forcing one keeps
      // the meaning unambiguous.
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["retainDays"],
        message: `Board "${ctx.value.key}" sets both retain and retainDays. Set one: retain for a window-count limit, retainDays for an age limit.`,
      });
    }
    if ((retain !== undefined || retainDays !== undefined) && window === undefined) {
      // An all-time board has one never-closing window; there is nothing for a window-based limit to
      // prune, and age-based deletion of live entries is out of scope for v1.
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: [retainDays !== undefined ? "retainDays" : "retain"],
        message: `Board "${ctx.value.key}" is all-time (no window), so retention does not apply. Remove retain/retainDays or give the board a window.`,
      });
    }
    if (window !== undefined) {
      try {
        assertValidSchedule(window);
      } catch (error) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["window"],
          message: `Board "${ctx.value.key}" has an invalid window schedule: ${(error as Error).message}`,
        });
      }
    }
    if (tiers) {
      // Worst-to-best in the board's direction: ascending thresholds on `desc`, descending on `asc`.
      // An out-of-order tier is unreachable, and silently unreachable is worse than rejected.
      for (let i = 1; i < tiers.length; i++) {
        const previous = tiers[i - 1] as LeaderboardTier;
        const current = tiers[i] as LeaderboardTier;
        const improves = direction === "desc" ? current.from > previous.from : current.from < previous.from;
        if (!improves) {
          ctx.issues.push({
            code: "custom",
            input: ctx.value,
            path: ["tiers", i, "from"],
            message: `Board "${ctx.value.key}" lists tier "${current.key}" after "${previous.key}", but its threshold does not improve on a ${direction} board. List tiers worst to best.`,
          });
        }
      }
    }
  });
export type LeaderboardBoard = z.output<typeof LeaderboardBoard>;

export const LeaderboardRank = z
  .union([
    z
      .literal("live")
      .describe("Rank is counted at read time. Always correct, no moving parts, and $0 under ~10k players."),
    z
      .object({
        materialize: z
          .string()
          .describe(
            "A UTC CRON expression for the rank refresh pass. `0 * * * *` is hourly. Faster means fresher ranks and a bigger bill; the cadence is a dial, not a switch.",
          ),
      })
      .describe("Rank is stored on the entry and refreshed on a schedule, making my-rank a single point read."),
  ])
  .describe(
    "How rank is computed. `live` counts better entries per request — correct and free for small boards, and quadratic as they grow. `{ materialize }` trades rank staleness for cost and is the documented path past ~100k players; a player's own score stays live either way. See docs/costs.md before choosing.",
  );
export type LeaderboardRank = z.output<typeof LeaderboardRank>;

export const LeaderboardConfig = z
  .object({
    boards: z
      .array(LeaderboardBoard)
      .min(1, "A leaderboard capability with no boards does nothing — configure at least one.")
      .describe("Every board this app ranks. The board set is config, not database rows."),
    rank: LeaderboardRank.prefault("live").describe("How rank is computed across every board."),
    serverAuthoritative: z
      .boolean()
      .default(true)
      .describe(
        "Require the submit scope to post a score. On by default, inverting the vendor norm — every platform that offers server-authoritative writes ships it off. Leave it on and submit from your trusted server; turn it off only if you accept that a player's device can post any score it likes.",
      ),
    submitScope: z
      .string()
      .min(1)
      .default("leaderboard:submit")
      .describe(
        "The AuthContext scope a session must carry to submit a score while `serverAuthoritative` is on. Mint it for your server's own token, never for a player's.",
      ),
    adminScope: z
      .string()
      .min(1)
      .default("leaderboard:admin")
      .describe("The AuthContext scope required to hide or remove another player's entry."),
    visibleByDefault: z
      .boolean()
      .default(true)
      .describe(
        "Whether a new entry appears on the board before the player says otherwise. Set false to make the board opt-in, so a player only shows up once they consent.",
      ),
  })
  .describe("Configuration for the leaderboard capability — the board set, how rank is computed, and who may write.")
  .check((ctx) => {
    const keys = ctx.value.boards.map((b) => b.key);
    const duplicates = [...new Set(keys.filter((key, i) => keys.indexOf(key) !== i))];
    if (duplicates.length > 0) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["boards"],
        message: `Duplicate board keys: ${duplicates.join(", ")}. Two boards sharing a key would merge their entries.`,
      });
    }
    const rank = ctx.value.rank;
    if (typeof rank === "object") {
      try {
        assertValidSchedule(rank.materialize);
      } catch (error) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["rank", "materialize"],
          message: `Invalid materialize schedule: ${(error as Error).message}`,
        });
      }
    }
  });
export type LeaderboardConfig = z.output<typeof LeaderboardConfig>;
export type LeaderboardConfigInput = z.input<typeof LeaderboardConfig>;

/** The board with this key, or undefined. Board keys come from config, so an unknown key is a 404. */
export function resolveBoard(config: LeaderboardConfig, key: string): LeaderboardBoard | undefined {
  return config.boards.find((board) => board.key === key);
}

/** The rank refresh CRON, or undefined when rank is live and no refresh worker is needed. */
export function materializeSchedule(config: LeaderboardConfig): string | undefined {
  return typeof config.rank === "object" ? config.rank.materialize : undefined;
}
