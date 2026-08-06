// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * `@pithy-sh/leaderboard` throw sugar. The `leaderboard/*` codes live in core's closed `KitErrorPayload`
 * union (CLAUDE.md §Errors: capabilities add their codes to the one union); these subclasses are the
 * package-local vehicles that set one of those members — the same pattern as `@pithy-sh/media` and
 * `@pithy-sh/turnstile`. Runtime code in this package throws one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface LeaderboardErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
}

export class LeaderboardBoardNotFoundError extends PithyError {
  constructor(args: LeaderboardErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "leaderboard/board_not_found",
        status: 404,
        message: args.message ?? "That board does not exist.",
        action: args.action ?? "Check the board key against the `boards` list in pithy.config.ts.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class LeaderboardEntryNotFoundError extends PithyError {
  constructor(args: LeaderboardErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "leaderboard/entry_not_found",
        status: 404,
        message: args.message ?? "You have no score on that board yet.",
        action: args.action ?? "Submit a score first.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class LeaderboardScoreRejectedError extends PithyError {
  constructor(args: LeaderboardErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "leaderboard/score_rejected",
        status: 400,
        message: args.message ?? "That score is outside the board's allowed range.",
        action: args.action ?? "Submit a score within the board's min and max.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class LeaderboardSubmitForbiddenError extends PithyError {
  constructor(args: LeaderboardErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "leaderboard/submit_forbidden",
        status: 403,
        message: args.message ?? "This session may not submit scores.",
        action:
          args.action ??
          "Submit from your trusted server with the board's submit scope, or set `serverAuthoritative: false` to let clients post directly.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class LeaderboardBoardImmutableError extends PithyError {
  constructor(args: LeaderboardErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "leaderboard/board_immutable",
        status: 409,
        message: args.message ?? "That board's definition cannot change.",
        action: args.action ?? "Give the changed board a new key. The old board keeps its recorded scores.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class LeaderboardInvalidScheduleError extends PithyError {
  constructor(args: LeaderboardErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "leaderboard/invalid_schedule",
        status: 500,
        message: args.message ?? "That board's window schedule is invalid.",
        action: args.action ?? "Fix the board's `window` CRON expression in pithy.config.ts.",
        detail: args.detail,
      },
      options,
    );
  }
}
