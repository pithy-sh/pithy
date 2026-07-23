import { z } from "zod";
import { MultiplayerInvalidMoveError, MultiplayerInvalidTransitionError } from "../../error/errors";
import { type BetDecision, type PendingBet, wageringTable } from "../patterns/wageringTable";

/**
 * Craps — the flagship **wagering-table** game (built on the {@link wageringTable} pattern).
 *
 * The pattern owns the wagering plumbing: the bet book, the wallet holds placed when a bet lands, the
 * settlement when a bet resolves, and the persistent-table lifecycle. Craps supplies only the game: what a
 * valid bet is, who may roll (the shooter), and how a roll decides each pending bet. The house is the
 * counterparty for wins and losses — off the players' ledger — so how you fund and book the house edge is
 * yours, and Pithy takes no position on whether the chips map to money.
 *
 * The bets are the three that define craps' structure — a subset, not the whole layout:
 * - **Pass line** — placed on the come-out. Wins on a come-out 7 or 11, or when the shooter makes the point;
 *   loses on a come-out 2, 3, or 12, or on a seven-out. Even money.
 * - **Don't Pass** — the opposite. Wins on a come-out 2 or 3 (12 pushes), or on a seven-out; loses on a
 *   come-out 7 or 11, or when the point is made. Even money.
 * - **Field** — a one-roll bet: wins on 2, 3, 4, 9, 10, 11, 12 (2 and 12 pay double), loses on 5, 6, 7, 8.
 */

export const CrapsConfig = z
  .object({
    currency: z
      .string()
      .min(1)
      .describe("The wallet currency bets and payouts are denominated in (from the wallet capability's `currencies`)."),
    minBet: z.number().int().min(1).default(1).describe("The smallest bet allowed, in the currency's minor unit."),
    maxBet: z.number().int().min(1).optional().describe("The largest bet allowed, or omit for no cap."),
  })
  .describe("The craps table's rules — the betting currency and the bet size limits.")
  .check((ctx) => {
    if (ctx.value.maxBet !== undefined && ctx.value.maxBet < ctx.value.minBet)
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["maxBet"],
        message: `maxBet ${ctx.value.maxBet} is below minBet ${ctx.value.minBet}.`,
      });
  });
export type CrapsConfig = z.output<typeof CrapsConfig>;

export const CrapsBetType = z
  .enum(["pass", "dont-pass", "field"])
  .describe("A craps bet: `pass`, `dont-pass`, or `field`.");
export type CrapsBetType = z.infer<typeof CrapsBetType>;

/** A craps bet input — the type and the stake. */
export const CrapsBet = z
  .object({ type: CrapsBetType.describe("Which bet."), amount: z.number().int().describe("The stake.") })
  .describe("A craps bet.");
export type CrapsBet = z.infer<typeof CrapsBet>;

/** The craps round state — the come-out/point phase, the point, the shooter, and the last roll. */
export const CrapsRound = z
  .object({
    phase: z.enum(["come-out", "point"]).describe("`come-out` (no point yet) or `point` (rolling to make the point)."),
    point: z.number().int().nullable().describe("The established point (4,5,6,8,9,10), or null on the come-out."),
    shooterIndex: z
      .number()
      .int()
      .describe("Index into the roster of the current shooter — the only player who may roll."),
    lastRoll: z
      .tuple([z.number(), z.number()])
      .nullable()
      .describe("The two dice of the last roll, or null before the first."),
  })
  .describe("The craps round state.");
export type CrapsRound = z.infer<typeof CrapsRound>;

/** The field bet's one-roll outcome for a dice sum: a win multiplier (1 or 2), or null to lose. */
function fieldWin(sum: number): number | null {
  if (sum === 2 || sum === 12) return 2;
  if (sum === 3 || sum === 4 || sum === 9 || sum === 10 || sum === 11) return 1;
  return null; // 5,6,7,8 lose
}

/** Resolve a pass/don't-pass bet against a roll in a phase. win/lose/push, or null if it carries. */
function passOutcome(
  type: "pass" | "dont-pass",
  phase: "come-out" | "point",
  point: number | null,
  sum: number,
): "win" | "lose" | "push" | null {
  if (phase === "come-out") {
    if (sum === 7 || sum === 11) return type === "pass" ? "win" : "lose";
    if (sum === 2 || sum === 3) return type === "pass" ? "lose" : "win";
    if (sum === 12) return type === "pass" ? "lose" : "push";
    return null; // point established; the bet carries
  }
  if (sum === point) return type === "pass" ? "win" : "lose";
  if (sum === 7) return type === "pass" ? "lose" : "win"; // seven-out
  return null; // no decision; the bet carries
}

export const crapsGame = wageringTable<CrapsConfig, CrapsRound, CrapsBet>({
  kind: "craps",
  config: CrapsConfig,
  round: CrapsRound,
  bet: CrapsBet,
  minPlayers: 1,
  currency: (config) => config.currency,

  startRound: () => ({ phase: "come-out", point: null, shooterIndex: 0, lastRoll: null }),

  placeBet(ctx, round, playerId, bet, bets) {
    if (bet.amount < ctx.config.minBet || (ctx.config.maxBet !== undefined && bet.amount > ctx.config.maxBet)) {
      throw new MultiplayerInvalidMoveError({
        message: `Bet must be between ${ctx.config.minBet} and ${ctx.config.maxBet ?? "∞"}.`,
        detail: `Bet ${bet.amount} outside limits.`,
      });
    }
    if ((bet.type === "pass" || bet.type === "dont-pass") && round.phase !== "come-out") {
      throw new MultiplayerInvalidTransitionError({
        message: "Pass and don't-pass bets are only allowed on the come-out.",
        detail: `Phase ${round.phase}.`,
      });
    }
    if (bets.some((b) => b.userId === playerId && (b.data as { type: string }).type === bet.type)) {
      throw new MultiplayerInvalidTransitionError({
        message: `You already have a ${bet.type} bet pending.`,
        detail: `Duplicate ${bet.type} for ${playerId}.`,
      });
    }
    return { amount: bet.amount, data: { type: bet.type } };
  },

  // Only the shooter may roll. Clamp the index in case the roster shrank since it was set.
  eventDriver: (ctx, round) => ctx.players[round.shooterIndex % Math.max(1, ctx.players.length)] ?? null,

  runEvent(ctx, round, bets) {
    const d1 = ctx.random.int(1, 6);
    const d2 = ctx.random.int(1, 6);
    const sum = d1 + d2;

    const decisions: BetDecision[] = [];
    for (const bet of bets) {
      const type = (bet.data as { type: CrapsBetType }).type;
      if (type === "field") {
        const w = fieldWin(sum);
        decisions.push({ ref: bet.ref, result: w === null ? "lose" : "win", payout: w === null ? 0 : bet.amount * w });
      } else {
        const result = passOutcome(type, round.phase, round.point, sum);
        if (result !== null) decisions.push({ ref: bet.ref, result, payout: result === "win" ? bet.amount : 0 });
        // null → the pass/don't-pass bet carries (no decision)
      }
    }

    // Advance the round based on the pass-line outcome.
    let phase = round.phase;
    let point = round.point;
    let shooterIndex = round.shooterIndex;
    if (round.phase === "come-out") {
      if (sum === 4 || sum === 5 || sum === 6 || sum === 8 || sum === 9 || sum === 10) {
        phase = "point";
        point = sum;
      }
    } else if (sum === point) {
      phase = "come-out";
      point = null; // point made — same shooter
    } else if (sum === 7) {
      phase = "come-out";
      point = null;
      shooterIndex = ctx.players.length > 0 ? (round.shooterIndex + 1) % ctx.players.length : 0; // seven-out passes the dice
    }

    return { round: { phase, point, shooterIndex, lastRoll: [d1, d2] as [number, number] }, decisions };
  },

  view: (ctx, round) => ({
    phase: round.phase,
    point: round.point,
    shooter: ctx.players[round.shooterIndex % Math.max(1, ctx.players.length)] ?? null,
    lastRoll: round.lastRoll,
  }),
});

/** Re-exported so a caller (or a test) can reference a pending craps bet's shape. */
export type { PendingBet as CrapsPendingBet };
