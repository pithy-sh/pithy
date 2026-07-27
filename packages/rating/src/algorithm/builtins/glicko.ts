import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import type { RatingAlgorithm, RatingEntry } from "../algorithm";

/**
 * Glicko-2 — Mark Glickman's rating system, 1v1 only. A player carries a `rating` (the Elo-scale
 * estimate), a `rd` (rating deviation — the uncertainty band around that estimate), and a `vol`
 * (volatility — how erratic the player's results are). A game shrinks `rd` (we learn), and the
 * outcome plus expectation nudges `rating`. All the interesting math lives in {@link glicko.update}.
 *
 * Reference: Glickman, "Example of the Glicko-2 system" (glicko.net/glicko/glicko2.pdf). Constants:
 * the Glicko-2 internal scale factor is 173.7178 and the anchor rating is 1500.
 */

/** The Glicko-2 scale factor converting between the public Elo scale and the internal (μ, φ) scale. */
const SCALE = 173.7178;
/** The public-scale anchor rating that maps to internal μ = 0. */
const ANCHOR = 1500;
/** Convergence tolerance for the volatility (Illinois) iteration. */
const CONVERGENCE = 1e-6;

/** One player's persisted Glicko-2 state: their rating, its deviation, and their volatility. */
export const GlickoState = z
  .object({
    rating: z.number().describe("The player's Glicko rating on the public Elo scale (anchored at 1500)."),
    rd: z
      .number()
      .positive()
      .describe("Rating deviation — the uncertainty band around the rating; shrinks with each game."),
    vol: z
      .number()
      .positive()
      .describe("Volatility — how erratic the player's results are; governs how fast rating can move."),
  })
  .describe("A single player's Glicko-2 rating state, persisted between games.");
export type GlickoState = z.output<typeof GlickoState>;

/** The Glicko-2 tuning block. Every field defaults, so `GlickoParams.parse({})` yields the standard defaults. */
export const GlickoParams = z
  .object({
    tau: z
      .number()
      .positive()
      .default(0.5)
      .describe("System constant τ, constraining volatility change over time (typical 0.3–1.2; smaller = steadier)."),
    initialRating: z.number().default(1500).describe("A newcomer's starting rating on the public Elo scale."),
    initialRd: z
      .number()
      .positive()
      .default(350)
      .describe("A newcomer's starting rating deviation (maximal uncertainty)."),
    initialVol: z.number().positive().default(0.06).describe("A newcomer's starting volatility."),
  })
  .describe("Glicko-2 tuning parameters, each defaulted to Glickman's recommended values.");
export type GlickoParams = z.output<typeof GlickoParams>;

/** g(φ): the impact-of-opponent-uncertainty factor. A more uncertain opponent counts for less. */
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** E(μ, μ_j, φ_j): the expected score of the player against the opponent. */
function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Solve the new volatility σ' via the Illinois (regula-falsi) algorithm on Glickman's f(x).
 * `phi`, `v`, `delta` are already on the internal scale; `sigma` is the current volatility; `tau` the constant.
 */
function newVolatility(sigma: number, phi: number, v: number, delta: number, tau: number): number {
  const a = Math.log(sigma * sigma);
  const deltaSq = delta * delta;
  const phiSq = phi * phi;
  const tauSq = tau * tau;

  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (deltaSq - phiSq - v - ex);
    const den = 2 * (phiSq + v + ex) * (phiSq + v + ex);
    return num / den - (x - a) / tauSq;
  };

  let A = a;
  let B: number;
  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) {
      k++;
    }
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > CONVERGENCE) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }

  return Math.exp(A / 2);
}

/** Run the Glicko-2 single-game update for one player (rating r, rd, vol) against one opponent, given score s. */
function updateOne(player: GlickoState, opponent: GlickoState, s: number, tau: number): GlickoState {
  const mu = (player.rating - ANCHOR) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;
  const muJ = (opponent.rating - ANCHOR) / SCALE;
  const phiJ = opponent.rd / SCALE;

  const gJ = g(phiJ);
  const e = expectedScore(mu, muJ, phiJ);
  const v = 1 / (gJ * gJ * e * (1 - e));
  const delta = v * gJ * (s - e);

  const sigmaPrime = newVolatility(sigma, phi, v, delta, tau);

  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * gJ * (s - e);

  return {
    rating: SCALE * muPrime + ANCHOR,
    rd: SCALE * phiPrime,
    vol: sigmaPrime,
  };
}

/** Per-pair score from placements: lower place is better. 1 for a win, 0.5 for a tie, 0 for a loss. */
function scoreOf(myRank: number, theirRank: number): number {
  if (myRank < theirRank) return 1;
  if (myRank === theirRank) return 0.5;
  return 0;
}

export const glicko: RatingAlgorithm<GlickoState, GlickoParams> = {
  id: "glicko",
  params: GlickoParams,
  state: GlickoState,
  minPlayers: 2,
  maxPlayers: 2,
  supportsTeams: false,
  initial(params) {
    return { rating: params.initialRating, rd: params.initialRd, vol: params.initialVol };
  },
  update(params, entries, outcome) {
    const [a, b] = entries as readonly [RatingEntry<GlickoState>, RatingEntry<GlickoState>];
    const rankA = outcome.ranks[a.playerId];
    const rankB = outcome.ranks[b.playerId];
    if (rankA === undefined || rankB === undefined) {
      throw new InternalError({ detail: "glicko update received an outcome missing a player's rank." });
    }
    const sA = scoreOf(rankA, rankB);
    const sB = scoreOf(rankB, rankA);
    return {
      [a.playerId]: updateOne(a.state, b.state, sA, params.tau),
      [b.playerId]: updateOne(b.state, a.state, sB, params.tau),
    };
  },
  // Conservative skill: rating minus two deviations. A wide RD (an unproven player) is discounted,
  // so matchmaking and leaderboards rank on what we are confident the player is at least worth.
  skill(_params, state) {
    return state.rating - 2 * state.rd;
  },
};
