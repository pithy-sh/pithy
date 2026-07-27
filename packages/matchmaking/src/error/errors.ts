import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * `@pithy-sh/matchmaking` throw sugar. The `matchmaking/*` codes live in core's closed `ErrorPayload`
 * union; these subclasses set one of those members — the leaderboard/multiplayer pattern. Runtime code
 * throws one of these, never a plain `new Error`.
 */
interface MatchmakingErrorArgs {
  message?: string;
  action?: string;
  detail?: string;
}

export class MatchmakingRoomNotFoundError extends PithyError {
  constructor(args: MatchmakingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "matchmaking/room_not_found",
        status: 404,
        message: args.message ?? "That room does not exist.",
        action: args.action ?? "Ask the host for a fresh code — it may have expired or been used up.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MatchmakingRoomFullError extends PithyError {
  constructor(args: MatchmakingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "matchmaking/room_full",
        status: 409,
        message: args.message ?? "That room code is used up.",
        action: args.action ?? "Ask the host to open a new room.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MatchmakingInvalidCodeError extends PithyError {
  constructor(args: MatchmakingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "matchmaking/invalid_code",
        status: 400,
        message: args.message ?? "That is not a valid room code.",
        action: args.action ?? "Enter the code exactly as shared, e.g. WXYZ-1234.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MatchmakingInviteNotFoundError extends PithyError {
  constructor(args: MatchmakingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "matchmaking/invite_not_found",
        status: 404,
        message: args.message ?? "That invite does not exist.",
        action: args.action ?? "It may have been accepted, declined, or expired.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MatchmakingInviteForbiddenError extends PithyError {
  constructor(args: MatchmakingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "matchmaking/invite_forbidden",
        status: 403,
        message: args.message ?? "This invite is not yours to act on.",
        action: args.action ?? "Only the inviter or the invitee may act on an invite.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MatchmakingUserNotFoundError extends PithyError {
  constructor(args: MatchmakingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "matchmaking/user_not_found",
        status: 404,
        message: args.message ?? "No single user matches that invite.",
        action: args.action ?? "Invite by email for a unique identity — a display name may be ambiguous.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MatchmakingAlreadyFriendsError extends PithyError {
  constructor(args: MatchmakingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "matchmaking/already_friends",
        status: 409,
        message: args.message ?? "You are already connected, or a request is already pending.",
        action: args.action ?? "Wait for the pending request, or you are already friends.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MatchmakingFriendRequestNotFoundError extends PithyError {
  constructor(args: MatchmakingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "matchmaking/friend_request_not_found",
        status: 404,
        message: args.message ?? "There is no pending friend request to act on.",
        action: args.action ?? "The request may have been withdrawn or already answered.",
        detail: args.detail,
      },
      options,
    );
  }
}

export class MatchmakingNotQueuedError extends PithyError {
  constructor(args: MatchmakingErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "matchmaking/not_queued",
        status: 404,
        message: args.message ?? "You are not in this queue.",
        action: args.action ?? "Enqueue before checking your status or leaving.",
        detail: args.detail,
      },
      options,
    );
  }
}
