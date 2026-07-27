import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import type { RatingAlgorithm } from "../algorithm";

/**
 * TrueSkill — Microsoft's Bayesian skill-rating system, the built-in that rates *any* format: 1v1,
 * N-player free-for-all, and teams. Each player is a Gaussian belief over their true skill `N(μ, σ²)`;
 * a game shifts every belief toward the result, growing confident (σ shrinks) as evidence accrues. The
 * exposed, matchmaking-comparable number is the **conservative** skill `μ − 3σ`: a rating the player is
 * ~99.7% likely to exceed, so a newcomer's wide σ keeps them provisional until they've played.
 *
 * ## What this implementation is
 * A faithful, self-contained port of the standard two-team TrueSkill update (Herbrich et al. 2007), with
 * one deliberate approximation for 3+ teams. It carries its own truncated-Gaussian corrections (`v`/`w`)
 * and its own normal `pdf`/`cdf`/`ppf` — no external math dependency, pure and deterministic.
 *
 * ### The two-team update (exact for 1v1, N-player-one-vs-one, and 2-team formats)
 * Group players into teams. A team's mean is the **sum** of its members' μ; its variance is the **sum**
 * of members' σ² (after adding the dynamics term τ² to each player first, so uncertainty never collapses
 * to zero between games). For a winner team `w` and loser team `l`:
 * ```
 *   c² = varW + varL + 2β²            t = (μW − μL) / c            ε = drawMargin / c
 *   v, w = truncated-Gaussian corrections at (t, ε)   // win vs draw branch
 *   each player i:  μ_i += ±(σ_i²/c)·v      σ_i² *= (1 − (σ_i²/c²)·w)
 * ```
 * where `±` is `+` for the winning team and `−` for the losing team, and `σ_i²` is that player's
 * post-dynamics variance. The draw margin is `ppf((drawProbability+1)/2) · √n · β` with **n = 2** per
 * pairwise team comparison (the two "sides" of one comparison), standardized by dividing by `c`.
 *
 * ### 3+ teams — the adjacent-pair sequential approximation (DOCUMENTED APPROXIMATION)
 * A fully general N-team factor graph is not run. Instead teams are sorted by finishing place and each
 * **adjacent** pair (1st-vs-2nd, 2nd-vs-3rd, …) is updated as an independent two-team comparison off the
 * players' *original* (post-dynamics) states; per player the μ-deltas are **summed** and the σ² factors
 * are **multiplied**. This is the well-known sequential TrueSkill approximation: correct for 1v1 and
 * two-team games, and a close, order-consistent estimate for free-for-alls (a middle finisher who beats
 * the player below and loses to the one above nets out near their prior, exactly as expected).
 */

// ---------------------------------------------------------------------------------------------------
// Standard-normal helpers — erf (Abramowitz & Stegun 7.1.26, |error| ≤ 1.5e-7), its cdf, pdf, and the
// inverse-cdf ppf (Acklam's rational approximation, |rel. error| ≈ 1.15e-9). Exported so their accuracy
// is asserted directly in the test. Pure functions of their argument.
// ---------------------------------------------------------------------------------------------------

const INV_SQRT_2PI = 0.3989422804014327; // 1 / √(2π)

/** The Gauss error function, `erf(x)`, via Abramowitz & Stegun 7.1.26 (max abs error ~1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Standard-normal probability density `φ(x)`. */
export function normPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/** Standard-normal cumulative distribution `Φ(x)`. */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Standard-normal inverse cdf (quantile) `Φ⁻¹(p)`, Acklam's approximation. `p∈(0,1)`. */
export function normPpf(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  // Central (a/b) and tail (c/d) rational-approximation coefficients.
  const a0 = -3.969683028665376e1;
  const a1 = 2.209460984245205e2;
  const a2 = -2.759285104469687e2;
  const a3 = 1.38357751867269e2;
  const a4 = -3.066479806614716e1;
  const a5 = 2.506628277459239;
  const b0 = -5.447609879822406e1;
  const b1 = 1.615858368580409e2;
  const b2 = -1.556989798598866e2;
  const b3 = 6.680131188771972e1;
  const b4 = -1.328068155288572e1;
  const c0 = -7.784894002430293e-3;
  const c1 = -3.223964580411365e-1;
  const c2 = -2.400758277161838;
  const c3 = -2.549732539343734;
  const c4 = 4.374664141464968;
  const c5 = 2.938163982698783;
  const d0 = 7.784695709041462e-3;
  const d1 = 3.224671290700398e-1;
  const d2 = 2.445134137142996;
  const d3 = 3.754408661907416;
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
      (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -((((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1));
}

// ---------------------------------------------------------------------------------------------------
// Truncated-Gaussian corrections. Arguments are already standardized (divided by c): `t` is the scaled
// team-mean difference, `eps` the scaled draw margin. `v` is the additive mean multiplier, `w∈(0,1)` the
// multiplicative variance shrink. The draw variants follow the canonical signed forms (Herbrich et al.).
// ---------------------------------------------------------------------------------------------------

/** Mean multiplier for a decisive result (team ahead wins). */
function vWin(t: number, eps: number): number {
  const x = t - eps;
  const denom = normCdf(x);
  // Numerical floor: for an all-but-impossible upset the ratio underflows; fall back to the limit −x.
  return denom > 1e-50 ? normPdf(x) / denom : -x;
}

/** Variance multiplier for a decisive result; `w = v·(v + (t − eps))`. */
function wWin(t: number, eps: number): number {
  const x = t - eps;
  const v = vWin(t, eps);
  return v * (v + x);
}

/** Mean multiplier for a draw (signed by which team was favored). */
function vDraw(t: number, eps: number): number {
  const absT = Math.abs(t);
  const a = eps - absT;
  const b = -eps - absT;
  const denom = normCdf(a) - normCdf(b);
  const numer = normPdf(b) - normPdf(a);
  const magnitude = denom > 1e-50 ? numer / denom : a;
  return magnitude * (t < 0 ? -1 : 1);
}

/** Variance multiplier for a draw. */
function wDraw(t: number, eps: number): number {
  const absT = Math.abs(t);
  const a = eps - absT;
  const b = -eps - absT;
  const denom = normCdf(a) - normCdf(b);
  if (denom <= 1e-50) return 1;
  const v = vDraw(absT, eps); // magnitude only; sign is irrelevant once squared
  return v * v + (a * normPdf(a) - b * normPdf(b)) / denom;
}

// ---------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------

/**
 * TrueSkill tuning: the Gaussian priors and dynamics that govern how one game's result shifts each
 * player's μ (mean skill) and σ (uncertainty). Every field defaults to the classic TrueSkill values, so
 * `TrueSkillParams.parse({})` yields a working configuration.
 */
export const TrueSkillParams = z
  .object({
    mu: z
      .number()
      .default(25)
      .describe("Prior skill mean μ₀ for a newcomer — the center of the rating scale (classic 25)."),
    sigma: z
      .number()
      .positive()
      .default(25 / 3)
      .describe("Prior skill standard deviation σ₀ — a newcomer's uncertainty (25/3 ≈ 8.333, so μ−3σ starts at 0)."),
    beta: z
      .number()
      .positive()
      .default(25 / 6)
      .describe(
        "Performance width β — the skill gap worth ~76% win odds; larger β makes a single game move ratings less.",
      ),
    tau: z
      .number()
      .nonnegative()
      .default(25 / 300)
      .describe("Dynamics factor τ — variance added back each game so ratings stay responsive; 0 freezes uncertainty."),
    drawProbability: z
      .number()
      .min(0)
      .lt(1)
      .default(0.1)
      .describe("Assumed draw likelihood — sets the tie margin ε; 0 treats draws as impossible."),
  })
  .describe(
    "TrueSkill tuning: Gaussian priors (μ, σ) and dynamics (β, τ, draw rate) controlling how a result moves each player's belief.",
  );
export type TrueSkillParams = z.output<typeof TrueSkillParams>;

/**
 * A player's TrueSkill belief: a Gaussian over their true skill, persisted between games as a mean and a
 * standard deviation. The conservative, matchmaking-comparable skill is `μ − 3σ`.
 */
export const TrueSkillState = z
  .object({
    mu: z.number().describe("Mean skill estimate μ — the center of the player's current skill belief."),
    sigma: z.number().describe("Skill uncertainty σ (standard deviation) — shrinks as the player accumulates games."),
  })
  .describe("A player's TrueSkill belief N(μ, σ²); conservative skill is μ − 3σ.");
export type TrueSkillState = z.output<typeof TrueSkillState>;

// ---------------------------------------------------------------------------------------------------
// Algorithm
// ---------------------------------------------------------------------------------------------------

interface TrueSkillPlayer {
  playerId: string;
  mu: number;
  /** Post-dynamics variance σ² + τ², computed once and reused across every pairwise comparison. */
  varDyn: number;
}

interface TrueSkillTeam {
  /** Shared finishing place (lower is better); the min across members. */
  rank: number;
  members: TrueSkillPlayer[];
  /** Team mean = Σ member μ. */
  mu: number;
  /** Team variance = Σ member (σ² + τ²). */
  varDyn: number;
}

/**
 * TrueSkill: rate any format from a single result. `minPlayers` 2, `maxPlayers` unbounded, teams
 * supported. See the module doc for the two-team update and the adjacent-pair approximation for 3+ teams.
 */
export const trueskill: RatingAlgorithm<TrueSkillState, TrueSkillParams> = {
  id: "trueskill",
  params: TrueSkillParams,
  state: TrueSkillState,
  minPlayers: 2,
  maxPlayers: Number.POSITIVE_INFINITY,
  supportsTeams: true,

  initial(params) {
    return { mu: params.mu, sigma: params.sigma };
  },

  /** Conservative skill μ − 3σ: the value the player is ~99.7% likely to exceed. */
  skill(_params, state) {
    return state.mu - 3 * state.sigma;
  },

  update(params, entries, outcome) {
    const betaSq = params.beta * params.beta;
    const tauSq = params.tau * params.tau;
    // Draw margin in raw skill units; n = 2 per pairwise team comparison. Standardized per pair by /c.
    const drawMargin = normPpf((params.drawProbability + 1) / 2) * Math.SQRT2 * params.beta;

    // Index players with their once-computed post-dynamics variance, and seed the delta accumulators.
    const players = new Map<string, TrueSkillPlayer>();
    const deltaMu = new Map<string, number>();
    const varFactor = new Map<string, number>();
    for (const entry of entries) {
      const player: TrueSkillPlayer = {
        playerId: entry.playerId,
        mu: entry.state.mu,
        varDyn: entry.state.sigma * entry.state.sigma + tauSq,
      };
      players.set(entry.playerId, player);
      deltaMu.set(entry.playerId, 0);
      varFactor.set(entry.playerId, 1);
    }

    // Group players into teams (solo teams when no `teams` grouping is given). Members share a place.
    const teams = new Map<string, TrueSkillTeam>();
    for (const entry of entries) {
      const player = players.get(entry.playerId);
      const rank = outcome.ranks[entry.playerId];
      if (player === undefined || rank === undefined) {
        throw new InternalError({
          detail: `TrueSkill: entered player ${entry.playerId} is missing a finishing place in the outcome.`,
        });
      }
      const teamId = outcome.teams?.[entry.playerId] ?? entry.playerId;
      let team = teams.get(teamId);
      if (team === undefined) {
        team = { rank: Number.POSITIVE_INFINITY, members: [], mu: 0, varDyn: 0 };
        teams.set(teamId, team);
      }
      team.members.push(player);
      team.mu += player.mu;
      team.varDyn += player.varDyn;
      team.rank = Math.min(team.rank, rank);
    }

    // Sort teams best-first and update each adjacent pair as an independent two-team comparison,
    // accumulating μ-deltas (summed) and σ²-factors (multiplied) per player off their original states.
    const ordered = [...teams.values()].sort((first, second) => first.rank - second.rank);
    for (let i = 0; i < ordered.length - 1; i++) {
      const hi = ordered[i];
      const lo = ordered[i + 1];
      if (hi === undefined || lo === undefined) continue;
      const isDraw = hi.rank === lo.rank;
      const cSq = hi.varDyn + lo.varDyn + 2 * betaSq;
      const c = Math.sqrt(cSq);
      const t = (hi.mu - lo.mu) / c;
      const eps = drawMargin / c;
      const v = isDraw ? vDraw(t, eps) : vWin(t, eps);
      const w = isDraw ? wDraw(t, eps) : wWin(t, eps);

      for (const member of hi.members) {
        deltaMu.set(member.playerId, (deltaMu.get(member.playerId) ?? 0) + (member.varDyn / c) * v);
        varFactor.set(member.playerId, (varFactor.get(member.playerId) ?? 1) * (1 - (member.varDyn / cSq) * w));
      }
      for (const member of lo.members) {
        deltaMu.set(member.playerId, (deltaMu.get(member.playerId) ?? 0) - (member.varDyn / c) * v);
        varFactor.set(member.playerId, (varFactor.get(member.playerId) ?? 1) * (1 - (member.varDyn / cSq) * w));
      }
    }

    const result: Record<string, TrueSkillState> = {};
    for (const player of players.values()) {
      const newVar = player.varDyn * (varFactor.get(player.playerId) ?? 1);
      result[player.playerId] = {
        mu: player.mu + (deltaMu.get(player.playerId) ?? 0),
        sigma: Math.sqrt(Math.max(newVar, 0)),
      };
    }
    return result;
  },
};
