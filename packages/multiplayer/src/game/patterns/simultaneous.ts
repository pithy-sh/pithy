// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { MultiplayerInvalidTransitionError } from "../../error/errors";
import type { GameContext, GameModel, ModelOutcome, ResolveResult } from "../model";

/**
 * The **simultaneous** pattern — the base helper for games where every player submits a hidden choice at
 * the same time and the server resolves them together once all are in. Rock-paper-scissors, a sealed-bid
 * auction, a battle of secret moves, a hidden vote.
 *
 * It is "simultaneous" in the game-theory sense (players choose without seeing each other), enforced by a
 * *trusted server* holding the plaintext submissions until everyone has committed — which is the model this
 * package provides. (It is not a cryptographic commit-reveal protocol; a trustless hash-commit-then-reveal
 * scheme would be a separate variant.)
 *
 * A game built on this helper supplies only what is game-specific: the shape of a submission, any extra
 * validation, and how to score all submissions. The helper owns the lifecycle — collect one submission per
 * player, reject a second, resolve when the last lands — and the hidden-state boundary (your own submission
 * is visible; everyone else's is hidden until the game is terminal).
 */
export interface SimultaneousSpec<Config, Submission> {
  /** The game's `kind` — its registry key. */
  kind: string;
  /** The game's config schema (the `rules` block). */
  config: z.ZodType<Config>;
  /** The schema for one player's hidden submission — the body of their action. */
  submission: z.ZodType<Submission>;
  /** The fewest / most players (defaults to 2 / no cap). */
  minPlayers?: number;
  maxPlayers?: number;
  /** Extra validation of a submission beyond its schema (e.g. "exactly 3 distinct moves"). Throw a `PithyError`. */
  validate?: (config: Config, submission: Submission, ctx: GameContext<Config>) => void;
  /** Resolve every player's submission into an outcome (and optional ledger effects) once all have submitted. */
  score: (ctx: GameContext<Config>, submissions: Record<string, Submission>) => ResolveResult | ModelOutcome;
}

/** The persisted state of a simultaneous game: each player's hidden submission, keyed by user id. */
type SimultaneousState<Submission> = { submissions: Record<string, Submission> };

/** Build a {@link GameModel} for a simultaneous game from its {@link SimultaneousSpec}. */
export function simultaneous<Config, Submission>(
  spec: SimultaneousSpec<Config, Submission>,
): GameModel<Config, SimultaneousState<Submission>> {
  const state = z
    .object({
      submissions: z.record(z.string(), spec.submission).describe("Each player's hidden submission, keyed by user id."),
    })
    .describe(`The ${spec.kind} game's persisted submissions.`);
  const view = z
    .object({
      you: z
        .object({
          userId: z.string().describe("Your user id."),
          submitted: z.boolean().describe("Whether you have submitted."),
          submission: spec.submission.nullable().describe("Your own submission, or null before you submit."),
        })
        .describe("Your side of the game. Your own submission is always visible to you."),
      opponents: z
        .array(
          z
            .object({
              userId: z.string().describe("The opponent's user id."),
              submitted: z.boolean().describe("Whether they have submitted. Visible from the start."),
              submission: spec.submission
                .nullable()
                .describe("Their submission — null until the session is terminal, then revealed."),
            })
            .describe("One opponent, as you may see them."),
        )
        .describe("Every other player, in join order."),
    })
    .describe(`What one player sees of a ${spec.kind} game: their own submission, and who else has submitted.`);

  return {
    kind: spec.kind,
    config: spec.config,
    state,
    action: spec.submission,
    view,
    minPlayers: spec.minPlayers,
    maxPlayers: spec.maxPlayers,

    init: () => ({ submissions: {} }),

    apply(ctx, current, playerId, action) {
      if (current.submissions[playerId] !== undefined) {
        throw new MultiplayerInvalidTransitionError({
          message: "You have already submitted.",
          detail: `${playerId} already submitted in ${spec.kind}.`,
        });
      }
      const submission = spec.submission.parse(action);
      spec.validate?.(ctx.config, submission, ctx);
      return { state: { submissions: { ...current.submissions, [playerId]: submission } } };
    },

    isComplete: (ctx, current) => ctx.players.every((player) => current.submissions[player] !== undefined),

    resolve(ctx, current) {
      const result = spec.score(ctx, current.submissions);
      return "outcome" in result ? result : { outcome: result };
    },

    // The hidden-state boundary: your submission is always visible; opponents' are hidden until the reveal.
    redact(ctx, current, viewerId, revealed) {
      return {
        you: {
          userId: viewerId,
          submitted: current.submissions[viewerId] !== undefined,
          submission: current.submissions[viewerId] ?? null,
        },
        opponents: ctx.players
          .filter((member) => member !== viewerId)
          .map((member) => ({
            userId: member,
            submitted: current.submissions[member] !== undefined,
            submission: revealed ? (current.submissions[member] ?? null) : null,
          })),
      };
    },
  };
}
