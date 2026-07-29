import { z } from "zod";
import { MultiplayerInvalidTransitionError } from "../../error/errors";
import type { LedgerEffect } from "../effects";
import type { GameContext, GameModel } from "../model";

/**
 * The **wagering-table** pattern — the base helper for banked casino games: a persistent table where
 * players place bets on a random event, and the house is the counterparty. Craps, roulette, sic bo.
 *
 * The helper owns the wagering plumbing that every such game shares: the **bet book** (tracking pending
 * bets), the ledger **holds** placed when a bet lands, and the **settlement** (release/capture/credit) when
 * a bet resolves — plus the persistent-table lifecycle (it never ends on a round; leaving returns a
 * player's open bets). A game built on it supplies only the game-specific parts: what a valid bet is, who
 * may trigger the random event, and how that event decides each pending bet. It never touches a hold ref or
 * a ledger effect directly.
 *
 * Use it with `mode: "table"` and pair it with `@pithy-sh/ledger`.
 */

/** A bet the helper is holding: the player, the ledger hold `ref`, the staked `amount`, and game-specific `data`. */
export interface PendingBet {
  userId: string;
  ref: string;
  amount: number;
  data: unknown;
}

/** A game's decision on a pending bet after a random event: won `payout`, lost, or pushed (stake returned). */
export interface BetDecision {
  ref: string;
  result: "win" | "lose" | "push";
  payout: number;
}

export interface WageringTableSpec<Config, Round, BetInput> {
  /** The game's `kind` — its registry key. */
  kind: string;
  /** The game's config schema (the `rules` block). */
  config: z.ZodType<Config>;
  /** The schema for the round-specific state (a craps come-out/point, a roulette between-spins). */
  round: z.ZodType<Round>;
  /** The schema for a bet's input (the body of a `bet` action). */
  bet: z.ZodType<BetInput>;
  minPlayers?: number;
  maxPlayers?: number;
  /** The ledger currency bets are held and paid in. */
  currency: (config: Config) => string;
  /** The initial round state. */
  startRound: (ctx: GameContext<Config>) => Round;
  /** Validate a bet against the round and the player's existing bets; return the stake to hold plus `data` to store with it. Throw on illegal. */
  placeBet: (
    ctx: GameContext<Config>,
    round: Round,
    playerId: string,
    bet: BetInput,
    bets: readonly PendingBet[],
  ) => { amount: number; data: unknown };
  /** The member allowed to trigger the random event now (a shooter), or null to allow anyone. */
  eventDriver?: (ctx: GameContext<Config>, round: Round) => string | null;
  /** Run the random event (roll, spin): advance the round and decide each pending bet. The helper settles them. */
  runEvent: (
    ctx: GameContext<Config>,
    round: Round,
    bets: readonly PendingBet[],
  ) => { round: Round; decisions: BetDecision[] };
  /** Optional view of the round; the helper adds the bet book around it. */
  view?: (ctx: GameContext<Config>, round: Round, viewerId: string) => unknown;
}

type TableState<Round> = { round: Round; bets: PendingBet[]; betSeq: number; lastDecisions: BetDecision[] };

/** Build a {@link GameModel} for a banked wagering table from its {@link WageringTableSpec}. */
export function wageringTable<Config, Round, BetInput>(
  spec: WageringTableSpec<Config, Round, BetInput>,
): GameModel<Config, TableState<Round>> {
  const PendingBetSchema = z
    .object({
      userId: z.string().describe("The player who placed the bet."),
      ref: z.string().describe("The ledger hold ref."),
      amount: z.number().int().describe("The staked amount."),
      data: z.unknown().describe("Game-specific bet data."),
    })
    .describe("A pending bet holding a stake.");
  const state = z
    .object({
      round: spec.round.describe("The round-specific state."),
      bets: z.array(PendingBetSchema).describe("Pending bets, each holding its stake."),
      betSeq: z.number().int().describe("A monotonic counter making each bet's hold ref unique."),
      lastDecisions: z
        .array(z.object({ ref: z.string(), result: z.enum(["win", "lose", "push"]), payout: z.number() }))
        .describe("How the last event decided each bet."),
    })
    .describe(`The ${spec.kind} table's state — the round, the bet book, and the last event's decisions.`);
  const action = z
    .discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("bet").describe("Place a bet."), bet: spec.bet.describe("The bet.") })
        .describe("Place a bet."),
      z
        .object({ kind: z.literal("event").describe("Trigger the random event (roll/spin).") })
        .describe("Trigger the event."),
    ])
    .describe("A wagering-table action — place a bet, or trigger the event.");

  return {
    kind: spec.kind,
    config: spec.config,
    state,
    minPlayers: spec.minPlayers ?? 1,
    maxPlayers: spec.maxPlayers,

    init: (ctx) => ({ round: spec.startRound(ctx), bets: [], betSeq: 0, lastDecisions: [] }),

    apply(ctx, current, playerId, rawAction) {
      const parsed = action.parse(rawAction);

      if (parsed.kind === "bet") {
        const { amount, data } = spec.placeBet(ctx, current.round, playerId, parsed.bet as BetInput, current.bets);
        const ref = `${ctx.sessionId}:bet:${current.betSeq}`;
        const effects: LedgerEffect[] = [
          { op: "hold", userId: playerId, currency: spec.currency(ctx.config), amount, ref },
        ];
        return {
          state: {
            ...current,
            betSeq: current.betSeq + 1,
            bets: [...current.bets, { userId: playerId, ref, amount, data }],
          },
          effects,
        };
      }

      // An event — check the driver (shooter), then run it and settle the decided bets.
      const driver = spec.eventDriver?.(ctx, current.round);
      if (driver !== undefined && driver !== null && driver !== playerId) {
        throw new MultiplayerInvalidTransitionError({
          message: "It is not your turn to trigger the event.",
          detail: `${playerId} is not the driver (${driver}).`,
        });
      }
      const { round, decisions } = spec.runEvent(ctx, current.round, current.bets);
      const decided = new Map(decisions.map((d) => [d.ref, d]));
      const currency = spec.currency(ctx.config);
      const effects: LedgerEffect[] = [];
      for (const bet of current.bets) {
        const decision = decided.get(bet.ref);
        if (!decision) continue; // no decision — the bet carries to the next event
        if (decision.result === "lose") {
          effects.push({ op: "capture", ref: bet.ref });
        } else {
          effects.push({ op: "release", ref: bet.ref }); // win or push: return the stake
          if (decision.result === "win" && decision.payout > 0) {
            effects.push({
              op: "credit",
              userId: bet.userId,
              currency,
              amount: decision.payout,
              ref: `${bet.ref}:win`,
              memo: `${spec.kind} win`,
            });
          }
        }
      }
      const bets = current.bets.filter((b) => !decided.has(b.ref));
      return { state: { round, bets, betSeq: current.betSeq, lastDecisions: decisions }, effects };
    },

    isComplete: () => false, // a table runs until closed or emptied (the session's table lifecycle)
    resolve: () => ({ outcome: { scores: {}, winnerUserId: null, draw: false } }),

    onLeave(_ctx, current, playerId) {
      // Return the leaver's held stakes and drop their bets.
      const effects: LedgerEffect[] = current.bets
        .filter((b) => b.userId === playerId)
        .map((b) => ({ op: "release", ref: b.ref }));
      return { state: { ...current, bets: current.bets.filter((b) => b.userId !== playerId) }, effects };
    },

    redact(ctx, current, viewerId) {
      const driver = spec.eventDriver?.(ctx, current.round) ?? null;
      return {
        ...(spec.view ? { round: spec.view(ctx, current.round, viewerId) } : { round: current.round }),
        driver,
        yourTurnToTrigger: driver === null || driver === viewerId,
        bets: current.bets.map((b) => ({ userId: b.userId, amount: b.amount, data: b.data })),
        lastDecisions: current.lastDecisions,
      };
    },
  };
}
