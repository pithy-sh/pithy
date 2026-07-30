// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { MultiplayerInvalidMoveError } from "../../error/errors";
import type { ModelOutcome } from "../model";
import { simultaneous } from "../patterns/simultaneous";

/**
 * Battle — the flagship **simultaneous** game (built on the {@link simultaneous} pattern).
 *
 * Each player secretly picks offensive and defensive moves; when everyone has, the server resolves them
 * together. An offensive move scores its power unless *any* opponent's chosen defense blocks it — which is
 * what makes hidden state load-bearing, and generalizes cleanly from a 2-player duel to an N-player
 * free-for-all. The whole game is a config (the move catalogs) plus a scoring function; the simultaneous
 * lifecycle and the hidden-state boundary come from the pattern.
 */

export const OffenseMove = z
  .object({
    name: z
      .string()
      .min(1)
      .describe("The move's stable name — what a player names in their submission, and what a defense blocks."),
    power: z
      .number()
      .nonnegative()
      .describe("Points this move scores against opponents when it lands (i.e. no opponent blocked it)."),
  })
  .describe("One offensive move a player may pick — a name and the points it scores if unblocked.");
export type OffenseMove = z.infer<typeof OffenseMove>;

export const DefenseMove = z
  .object({
    name: z.string().min(1).describe("The move's stable name — what a player names in their submission."),
    blocks: z
      .string()
      .min(1)
      .describe(
        "The offensive move name this defense neutralizes. Must reference an offensive move that exists in this game.",
      ),
  })
  .describe("One defensive move a player may pick — a name and the offensive move it blocks.");
export type DefenseMove = z.infer<typeof DefenseMove>;

export const BattleConfig = z
  .object({
    offense: z
      .object({
        pick: z.number().int().min(0).describe("Exactly how many distinct offensive moves a player picks."),
        moves: z.array(OffenseMove).describe("The offensive catalog a player picks from."),
      })
      .describe("The offensive moves each player picks, and how many."),
    defense: z
      .object({
        pick: z.number().int().min(0).describe("Exactly how many distinct defensive moves a player picks."),
        moves: z.array(DefenseMove).describe("The defensive catalog a player picks from."),
      })
      .describe("The defensive moves each player picks, and how many. Set `pick: 0` for an offense-only game."),
  })
  .describe("The battle game's rules — the offensive and defensive move catalogs and pick counts.")
  .check((ctx) => {
    const { offense, defense } = ctx.value;
    const offenseNames = offense.moves.map((m) => m.name);
    const uniqueOffense = new Set(offenseNames);
    if (uniqueOffense.size !== offenseNames.length)
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["offense", "moves"],
        message: "Duplicate offensive move names.",
      });
    if (offense.pick > uniqueOffense.size)
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["offense", "pick"],
        message: `Asks for ${offense.pick} offensive moves but only ${uniqueOffense.size} exist.`,
      });
    const defenseNames = defense.moves.map((m) => m.name);
    const uniqueDefense = new Set(defenseNames);
    if (uniqueDefense.size !== defenseNames.length)
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["defense", "moves"],
        message: "Duplicate defensive move names.",
      });
    if (defense.pick > uniqueDefense.size)
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["defense", "pick"],
        message: `Asks for ${defense.pick} defensive moves but only ${uniqueDefense.size} exist.`,
      });
    for (let i = 0; i < defense.moves.length; i++) {
      const move = defense.moves[i] as DefenseMove;
      if (!uniqueOffense.has(move.blocks))
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["defense", "moves", i, "blocks"],
          message: `Defense "${move.name}" blocks "${move.blocks}", which is not an offensive move.`,
        });
    }
  });
export type BattleConfig = z.output<typeof BattleConfig>;

/** One player's secret picks — the submission a battle player commits. */
export const Move = z
  .object({
    offense: z
      .array(z.string())
      .describe("The offensive move names picked — exactly `offense.pick`, distinct, from the set."),
    defense: z
      .array(z.string())
      .describe("The defensive move names picked — exactly `defense.pick`, distinct, from the set."),
  })
  .describe("One player's secret battle picks.");
export type Move = z.infer<typeof Move>;

/** Validate one pick list: exact count, distinct, and every name from the allowed set. Throws otherwise. */
function assertPicks(kind: "offensive" | "defensive", picks: string[], pick: number, allowed: Set<string>): void {
  if (picks.length !== pick)
    throw new MultiplayerInvalidMoveError({
      message: `Pick exactly ${pick} ${kind} move${pick === 1 ? "" : "s"}.`,
      detail: `Expected ${pick} ${kind} moves, got ${picks.length}.`,
    });
  if (new Set(picks).size !== picks.length)
    throw new MultiplayerInvalidMoveError({
      message: `Your ${kind} moves must be distinct.`,
      detail: `Duplicate ${kind} moves.`,
    });
  for (const name of picks) {
    if (!allowed.has(name))
      throw new MultiplayerInvalidMoveError({
        message: `"${name}" is not one of this game's ${kind} moves.`,
        detail: `${kind} move "${name}" not in set.`,
      });
  }
}

/** Validate a battle submission against the config. Throws {@link MultiplayerInvalidMoveError} on any violation. */
export function validateMove(config: BattleConfig, move: Move): void {
  assertPicks("offensive", move.offense, config.offense.pick, new Set(config.offense.moves.map((m) => m.name)));
  assertPicks("defensive", move.defense, config.defense.pick, new Set(config.defense.moves.map((m) => m.name)));
}

/** Score every player's picks: an offense scores unless any opponent's defense blocks it; highest wins, ties draw. */
export function scoreBattle(
  config: BattleConfig,
  submissions: Record<string, Move>,
  players: readonly string[],
): ModelOutcome {
  const power = new Map(config.offense.moves.map((m) => [m.name, m.power]));
  const blocksByDefense = new Map(config.defense.moves.map((d) => [d.name, d.blocks]));
  const scoreFor = (me: string): number => {
    const blocked = new Set<string>();
    for (const other of players) {
      if (other === me) continue;
      for (const name of submissions[other]?.defense ?? []) {
        const blocks = blocksByDefense.get(name);
        if (blocks) blocked.add(blocks);
      }
    }
    return (submissions[me]?.offense ?? []).reduce(
      (sum, move) => sum + (blocked.has(move) ? 0 : (power.get(move) ?? 0)),
      0,
    );
  };
  const scores: Record<string, number> = {};
  for (const player of players) scores[player] = scoreFor(player);
  const top = Math.max(...players.map((p) => scores[p] as number));
  const leaders = players.filter((p) => scores[p] === top);
  const draw = leaders.length !== 1;
  return { scores, winnerUserId: draw ? null : (leaders[0] as string), draw };
}

export const battleGame = simultaneous<BattleConfig, Move>({
  kind: "battle",
  config: BattleConfig,
  submission: Move,
  minPlayers: 2,
  validate: (config, move) => validateMove(config, move),
  score: (ctx, submissions) => scoreBattle(ctx.config, submissions, ctx.players),
});
