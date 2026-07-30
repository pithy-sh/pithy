// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * `@pithy-sh/multiplayer` throw sugar. The `multiplayer/*` codes live in core's closed `ErrorPayload`
 * union (CLAUDE.md §Errors: capabilities add their codes to the one union); these subclasses are the
 * package-local vehicles that set one of those members — the same pattern as `@pithy-sh/leaderboard` and
 * `@pithy-sh/media`. Runtime code in this package throws one of these, never a plain `new Error`.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface MultiplayerErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: string;
  /** A remediation hint (CLI action line). */
  action?: string;
  /** Internal context for logs + audit. Never serialized to clients. */
  detail?: string;
}

export class MultiplayerGameNotFoundError extends PithyError {
  constructor(args: MultiplayerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "multiplayer/game_not_found",
        status: 404,
        message: args.message ?? "That game does not exist.",
        action: args.action ?? "Check the game key against the `games` list in pithy.config.ts.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MultiplayerSessionNotFoundError extends PithyError {
  constructor(args: MultiplayerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "multiplayer/session_not_found",
        status: 404,
        message: args.message ?? "That session does not exist.",
        action: args.action ?? "Create a session first, then share its id with the other player.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MultiplayerNotAMemberError extends PithyError {
  constructor(args: MultiplayerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "multiplayer/not_a_member",
        status: 403,
        message: args.message ?? "You are not a member of this session.",
        action: args.action ?? "Join the session before acting in it.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MultiplayerSessionFullError extends PithyError {
  constructor(args: MultiplayerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "multiplayer/session_full",
        status: 409,
        message: args.message ?? "This session is full.",
        action: args.action ?? "Create a new session — this one already has both players.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MultiplayerInvalidTransitionError extends PithyError {
  constructor(args: MultiplayerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "multiplayer/invalid_transition",
        status: 409,
        message: args.message ?? "That action is not allowed right now.",
        action:
          args.action ?? "Check the session's phase before acting — you may have already committed, or it may be over.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MultiplayerInvalidMoveError extends PithyError {
  constructor(args: MultiplayerErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "multiplayer/invalid_move",
        status: 400,
        message: args.message ?? "That move is not allowed.",
        action: args.action ?? "Commit the exact number of distinct moves the game requires, each from its move set.",
        detail: args.detail,
      },
      options,
    );
  }
}
