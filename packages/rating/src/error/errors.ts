// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * `@pithy-sh/rating` throw sugar. The `rating/*` codes live in core's closed `KitErrorPayload` union
 * (CLAUDE.md §Errors: capabilities add their codes to the one union); these subclasses are the
 * package-local vehicles that set one of those members — the same pattern as `@pithy-sh/leaderboard` and
 * `@pithy-sh/multiplayer`. Runtime code in this package throws one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface RatingErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
}

/** A game wires a rating algorithm id that no one registered. Thrown at assembly. */
export class RatingUnknownAlgorithmError extends PithyError {
  constructor(args: RatingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "rating/unknown_algorithm",
        status: 400,
        message: args.message ?? "That rating algorithm does not exist.",
        action:
          args.action ?? "Use a built-in (elo, glicko, trueskill) or register one with registerRatingAlgorithm().",
        detail: args.detail,
      },
      options,
    );
  }
}

/** A game's roster or team format falls outside the chosen algorithm's support. Thrown at assembly. */
export class RatingUnsupportedPlayerCountError extends PithyError {
  constructor(args: RatingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "rating/unsupported_player_count",
        status: 400,
        message: args.message ?? "This algorithm cannot rate that game's shape.",
        action: args.action ?? "Use trueskill for N-player or team games; elo and glicko are 1v1 only.",
        detail: args.detail,
      },
      options,
    );
  }
}

/** A game's `algoParams` block failed the algorithm's own validation. Thrown at assembly. */
export class RatingInvalidParamsError extends PithyError {
  constructor(args: RatingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "rating/invalid_params",
        status: 400,
        message: args.message ?? "The algorithm's tuning is invalid.",
        action: args.action ?? "Fix the game's `algoParams` block in pithy.config.ts.",
        detail: args.detail,
      },
      options,
    );
  }
}

/** A request referenced a game key that is not configured. */
export class RatingGameNotFoundError extends PithyError {
  constructor(args: RatingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "rating/game_not_found",
        status: 404,
        message: args.message ?? "That game does not exist.",
        action: args.action ?? "Check the game key against the `games` list in pithy.config.ts.",
        detail: args.detail,
      },
      options,
    );
  }
}

/** A request referenced a rating pool no game configures. */
export class RatingPoolNotFoundError extends PithyError {
  constructor(args: RatingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "rating/pool_not_found",
        status: 404,
        message: args.message ?? "That rating pool does not exist.",
        action: args.action ?? "Reference a pool a configured game reads or writes.",
        detail: args.detail,
      },
      options,
    );
  }
}

/** The authenticated caller lacks the server-authoritative record scope. */
export class RatingRecordForbiddenError extends PithyError {
  constructor(args: RatingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "rating/record_forbidden",
        status: 403,
        message: args.message ?? "You may not record game outcomes.",
        action: args.action ?? "Record outcomes from a trusted server holding the record scope.",
        detail: args.detail,
      },
      options,
    );
  }
}
