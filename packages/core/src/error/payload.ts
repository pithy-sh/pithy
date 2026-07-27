import { z } from "zod";

/**
 * The error object model. One Zod schema is the whole definition of every failure Pithy
 * can emit: the discriminated union `ErrorPayload` is the closed taxonomy, keyed on a
 * machine-readable `code`. The `PithyError` class (./pithyError) is only the throw/catch
 * vehicle that carries one of these payloads; the surfaces (HTTP, terminal) are encoders
 * over this schema. `.describe()` on every field feeds the generated error catalog.
 */

/** A single field-level validation failure, mirrored from a Zod issue for the wire. */
export const ValidationIssue = z
  .object({
    path: z
      .array(z.union([z.string(), z.number()]))
      .describe("Path to the offending field, e.g. ['user', 0, 'email']."),
    message: z.string().describe("Human-readable reason this field failed."),
    code: z.string().describe("Zod issue code, e.g. 'invalid_type', 'too_small'."),
  })
  .describe("A single field-level validation failure, mirrored from a ZodIssue.");
export type ValidationIssue = z.infer<typeof ValidationIssue>;

/** Fields safe to expose to clients. Present on every member, public and wire alike. */
const publicFields = {
  message: z.string().describe("Public, safe-to-expose summary. Sent to clients and shown in the terminal."),
  action: z.string().optional().describe("Remediation hint. Becomes the CLI action line."),
};

/** The internal-only field. On `ErrorPayload`, never on the public/wire shape. */
const detailField = {
  detail: z
    .string()
    .optional()
    .describe("Internal context for logs + audit. NEVER serialized to clients — the HTTP codec strips it."),
};

// One public member per code. The `code` literal is the discriminator; `status` is pinned
// to the one HTTP status that code maps to, so a mismatched pair fails validation.
const InvalidInputPublic = z
  .object({
    code: z.literal("validation/invalid_input").describe("Input failed validation at a boundary."),
    status: z.literal(400).describe("Bad Request."),
    issues: z.array(ValidationIssue).describe("Field-level validation failures."),
    ...publicFields,
  })
  .describe("Input failed validation at a boundary (400).");

const InvalidTokenPublic = z
  .object({
    code: z.literal("auth/invalid_token").describe("The bearer/session credential is missing, expired, or invalid."),
    status: z.literal(401).describe("Unauthorized."),
    ...publicFields,
  })
  .describe("The caller's credential is missing, expired, or invalid (401).");

const ForbiddenPublic = z
  .object({
    code: z.literal("auth/forbidden").describe("The caller is authenticated but not allowed to do this."),
    status: z.literal(403).describe("Forbidden."),
    ...publicFields,
  })
  .describe("The caller is authenticated but lacks permission (403).");

const NotFoundPublic = z
  .object({
    code: z.literal("core/not_found").describe("The requested resource does not exist."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("The requested resource does not exist (404).");

const ConflictPublic = z
  .object({
    code: z.literal("core/conflict").describe("The request conflicts with current state (e.g. a duplicate)."),
    status: z.literal(409).describe("Conflict."),
    ...publicFields,
  })
  .describe("The request conflicts with current state (409).");

const RateLimitPublic = z
  .object({
    code: z.literal("rate_limit/exceeded").describe("The caller has sent too many requests."),
    status: z.literal(429).describe("Too Many Requests."),
    ...publicFields,
  })
  .describe("The caller has exceeded a rate limit (429).");

const InternalPublic = z
  .object({
    code: z.literal("core/internal").describe("An unexpected server-side failure."),
    status: z.literal(500).describe("Internal Server Error."),
    ...publicFields,
  })
  .describe("An unexpected server-side failure (500).");

// --- @pithy-sh/cloudflare: out-of-Worker CF REST client codes ---

const CloudflareNotConfiguredPublic = z
  .object({
    code: z
      .literal("cloudflare/not_configured")
      .describe("The CF REST client is missing required configuration (token, account, or a resource id)."),
    status: z.literal(500).describe("Internal Server Error — a configuration fault, not a client request."),
    ...publicFields,
  })
  .describe("The Cloudflare REST client is not fully configured (500).");

const CloudflareRequestFailedPublic = z
  .object({
    code: z.literal("cloudflare/request_failed").describe("A call to the Cloudflare REST API failed."),
    status: z.literal(502).describe("Bad Gateway — the upstream Cloudflare API returned an error."),
    ...publicFields,
  })
  .describe("A Cloudflare REST API call failed (502).");

const CloudflareInvalidResponsePublic = z
  .object({
    code: z
      .literal("cloudflare/invalid_response")
      .describe("A Cloudflare REST API response failed validation against its expected shape."),
    status: z.literal(502).describe("Bad Gateway — the upstream Cloudflare API returned an unexpected shape."),
    ...publicFields,
  })
  .describe("A Cloudflare REST API response did not match its expected shape (502).");

// --- @pithy-sh/secrets: encrypted secret store + CLI codes ---

const SecretNotFoundPublic = z
  .object({
    code: z.literal("secrets/not_found").describe("A requested secret is not present in the store."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A requested secret does not exist in the store (404).");

const SecretAlreadyExistsPublic = z
  .object({
    code: z
      .literal("secrets/already_exists")
      .describe("A secret with this name already exists; `create` refuses to overwrite it."),
    status: z.literal(409).describe("Conflict."),
    ...publicFields,
  })
  .describe("A secret with this name already exists (409).");

const SecretInvalidValuePublic = z
  .object({
    code: z.literal("secrets/invalid_value").describe("A secret value failed validation against its registry schema."),
    status: z.literal(400).describe("Bad Request."),
    ...publicFields,
  })
  .describe("A secret value failed validation against its registry schema (400).");

const SecretCryptoFailedPublic = z
  .object({
    code: z
      .literal("secrets/crypto_failed")
      .describe("Encrypting or decrypting a secret failed (a missing key version, or unreadable ciphertext)."),
    status: z.literal(500).describe("Internal Server Error — a crypto or key-configuration fault."),
    ...publicFields,
  })
  .describe("Encrypting or decrypting a secret failed (500).");

// --- @pithy-sh/email: job-table email platform codes ---

const EmailTemplateNotFoundPublic = z
  .object({
    code: z.literal("email/template_not_found").describe("The requested email template id is not registered."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("The requested email template does not exist (404).");

const EmailInvalidPayloadPublic = z
  .object({
    code: z
      .literal("email/invalid_payload")
      .describe("A template's input variables failed validation against its payload schema."),
    status: z.literal(400).describe("Bad Request."),
    ...publicFields,
  })
  .describe("Email template payload failed validation against its schema (400).");

const EmailInvalidTokenPublic = z
  .object({
    code: z
      .literal("email/invalid_token")
      .describe(
        "A callback token (click/open/unsubscribe) is malformed, expired, forged, or signed by an unknown key.",
      ),
    status: z.literal(400).describe("Bad Request — the signed token did not verify."),
    ...publicFields,
  })
  .describe("An email callback token failed verification (400).");

const EmailSuppressedPublic = z
  .object({
    code: z
      .literal("email/suppressed")
      .describe("The recipient address is on the suppression list and cannot be sent to."),
    status: z.literal(409).describe("Conflict — the address is suppressed."),
    ...publicFields,
  })
  .describe("The recipient is suppressed and was not sent to (409).");

const EmailRateLimitedPublic = z
  .object({
    code: z
      .literal("email/rate_limited")
      .describe("The Email Service rejected the send for a rate or daily-quota limit; the send is retryable."),
    status: z.literal(429).describe("Too Many Requests."),
    ...publicFields,
  })
  .describe("The Email Service rate or daily limit was hit (429).");

const EmailSendFailedPublic = z
  .object({
    code: z
      .literal("email/send_failed")
      .describe(
        "A send through the Email Service binding failed for a non-retryable reason (validation, sender, content).",
      ),
    status: z.literal(502).describe("Bad Gateway — the upstream Email Service returned a terminal error."),
    ...publicFields,
  })
  .describe("A send through the Email Service failed terminally (502).");

// --- @pithy-sh/turnstile: humanity-check middleware codes ---

const TurnstileMissingTokenPublic = z
  .object({
    code: z
      .literal("turnstile/missing_token")
      .describe("The request carried no Turnstile response token where one was required."),
    status: z.literal(400).describe("Bad Request — the humanity-check token is absent."),
    ...publicFields,
  })
  .describe("A required Turnstile token was missing from the request (400).");

const TurnstileFailedPublic = z
  .object({
    code: z
      .literal("turnstile/failed")
      .describe("The Turnstile token did not pass siteverify, or the check could not complete (fail closed)."),
    status: z.literal(403).describe("Forbidden — the humanity check did not pass; the request is denied."),
    ...publicFields,
  })
  .describe("A Turnstile humanity check failed or could not complete (403).");

const TurnstileConfigPublic = z
  .object({
    code: z
      .literal("turnstile/config")
      .describe("The Turnstile middleware is misconfigured — the secret-key binding is missing or empty."),
    status: z.literal(500).describe("Internal Server Error — a configuration fault, not a client request."),
    ...publicFields,
  })
  .describe("The Turnstile middleware is misconfigured (500).");

// --- @pithy-sh/audit: audit-trail recorder codes ---

const AuditInvalidEventPublic = z
  .object({
    code: z
      .literal("audit/invalid_event")
      .describe("An audit event failed validation against the AuditEvent schema (bad action, outcome, or actor)."),
    status: z.literal(400).describe("Bad Request — the event did not match its schema."),
    ...publicFields,
  })
  .describe("An audit event failed validation against its schema (400).");

const AuditWriteFailedPublic = z
  .object({
    code: z
      .literal("audit/write_failed")
      .describe(
        "Persisting an audit event to D1 failed after retries; the failure is logged, never thrown to a client.",
      ),
    status: z.literal(500).describe("Internal Server Error — the audit write could not be durably persisted."),
    ...publicFields,
  })
  .describe("Persisting an audit event failed (500). Recorded non-fatally; never breaks the audited action.");

// --- @pithy-sh/media: configurable media storage + AI enrichment codes ---

const MediaNotFoundPublic = z
  .object({
    code: z.literal("media/not_found").describe("A requested media record does not exist or was soft-deleted."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A requested media record does not exist (404).");

const MediaUnsupportedPublic = z
  .object({
    code: z
      .literal("media/unsupported")
      .describe("The media type, extension, or backend is not supported for the requested operation."),
    status: z.literal(400).describe("Bad Request — the operation does not apply to this media."),
    ...publicFields,
  })
  .describe("The media type or format is unsupported for this operation (400).");

const MediaStorageFailedPublic = z
  .object({
    code: z
      .literal("media/storage_failed")
      .describe("A storage operation failed — minting a direct-upload URL, or reading/deleting a stored object."),
    status: z.literal(502).describe("Bad Gateway — the upstream storage backend returned an error."),
    ...publicFields,
  })
  .describe("A media storage operation failed (502).");

const MediaEnrichmentFailedPublic = z
  .object({
    code: z
      .literal("media/enrichment_failed")
      .describe("An AI enrichment step (image-to-text, transcription, or extraction) failed."),
    status: z.literal(500).describe("Internal Server Error — an enrichment step could not complete."),
    ...publicFields,
  })
  .describe("A media AI-enrichment step failed (500).");

// --- @pithy-sh/leaderboard: optional ranking capability codes ---

const LeaderboardBoardNotFoundPublic = z
  .object({
    code: z
      .literal("leaderboard/board_not_found")
      .describe("No board with that key is configured. Board keys come from `pithy.config.ts`, not from the database."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A requested board key is not configured (404).");

const LeaderboardEntryNotFoundPublic = z
  .object({
    code: z
      .literal("leaderboard/entry_not_found")
      .describe("The player has no entry on this board in this window — they have never submitted, or it was removed."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A player has no entry on this board and window (404).");

const LeaderboardScoreRejectedPublic = z
  .object({
    code: z
      .literal("leaderboard/score_rejected")
      .describe("The submitted score failed the board's server-side `min`/`max` validation — the anti-cheat baseline."),
    status: z.literal(400).describe("Bad Request — the score is outside the board's configured bounds."),
    ...publicFields,
  })
  .describe("A submitted score failed the board's bounds validation (400).");

const LeaderboardSubmitForbiddenPublic = z
  .object({
    code: z
      .literal("leaderboard/submit_forbidden")
      .describe(
        "The caller lacks the board's submit scope. Server-authoritative writes are the default, so a player's own token cannot post a score.",
      ),
    status: z.literal(403).describe("Forbidden — the session is authenticated but not trusted to write scores."),
    ...publicFields,
  })
  .describe("The caller may not submit scores to this board (403).");

const LeaderboardBoardImmutablePublic = z
  .object({
    code: z
      .literal("leaderboard/board_immutable")
      .describe(
        "A board's `direction`, `aggregation`, or `window` changed after entries existed. Those fields are immutable across every vendor surveyed, and changing one would silently reinterpret stored scores.",
      ),
    status: z.literal(409).describe("Conflict — the config contradicts the recorded board definition."),
    ...publicFields,
  })
  .describe("A board's immutable definition changed after it started recording entries (409).");

const LeaderboardInvalidSchedulePublic = z
  .object({
    code: z
      .literal("leaderboard/invalid_schedule")
      .describe("A board's `window` CRON expression is malformed or never fires, so no window key could be derived."),
    status: z.literal(500).describe("Internal Server Error — the adopter's config is invalid, not the request."),
    ...publicFields,
  })
  .describe("A board's window CRON schedule is invalid (500).");

// --- @pithy-sh/multiplayer: authoritative session capability codes ---

const MultiplayerGameNotFoundPublic = z
  .object({
    code: z
      .literal("multiplayer/game_not_found")
      .describe("No game with that key is configured. Game keys come from `pithy.config.ts`, not from the database."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A requested game key is not configured (404).");

const MultiplayerSessionNotFoundPublic = z
  .object({
    code: z
      .literal("multiplayer/session_not_found")
      .describe("No session with that id exists, or it has been evicted. Session ids address a Durable Object."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A requested session does not exist (404).");

const MultiplayerNotAMemberPublic = z
  .object({
    code: z
      .literal("multiplayer/not_a_member")
      .describe(
        "The authenticated player is not a member of this session. Membership binds to the AuthContext user id, never to a client-supplied id.",
      ),
    status: z.literal(403).describe("Forbidden — authenticated, but not a participant in this session."),
    ...publicFields,
  })
  .describe("The caller is not a member of this session (403).");

const MultiplayerSessionFullPublic = z
  .object({
    code: z
      .literal("multiplayer/session_full")
      .describe("The session already has its full roster; no further players may join."),
    status: z.literal(409).describe("Conflict — the session's seats are taken."),
    ...publicFields,
  })
  .describe("The session roster is full (409).");

const MultiplayerInvalidTransitionPublic = z
  .object({
    code: z
      .literal("multiplayer/invalid_transition")
      .describe(
        "The requested action is not legal in the session's current phase — committing outside the commit phase, committing twice, or acting on a terminal (resolved/abandoned) session.",
      ),
    status: z.literal(409).describe("Conflict — the action contradicts the session's current state."),
    ...publicFields,
  })
  .describe("An action is illegal in the session's current phase (409).");

const MultiplayerInvalidMovePublic = z
  .object({
    code: z
      .literal("multiplayer/invalid_move")
      .describe(
        "A committed move failed the game's server-side validation — wrong shape, an unknown move, or a count outside the game's rules. The server never trusts or persists it.",
      ),
    status: z.literal(400).describe("Bad Request — the move is malformed or against the game's rules."),
    ...publicFields,
  })
  .describe("A committed move failed the game's server-side validation (400).");

// --- @pithy-sh/wallet: balance-ledger capability codes ---

const WalletCurrencyNotFoundPublic = z
  .object({
    code: z
      .literal("wallet/currency_not_found")
      .describe(
        "No currency with that code is configured. Currency codes come from `pithy.config.ts`, not the database.",
      ),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A requested currency code is not configured (404).");

const WalletAccountNotFoundPublic = z
  .object({
    code: z
      .literal("wallet/account_not_found")
      .describe("The player has no account in this currency yet — no funds have ever moved through it."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A player has no account in this currency (404).");

const WalletHoldNotFoundPublic = z
  .object({
    code: z.literal("wallet/hold_not_found").describe("No hold with that reference exists."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A referenced hold does not exist (404).");

const WalletInsufficientFundsPublic = z
  .object({
    code: z
      .literal("wallet/insufficient_funds")
      .describe(
        "The account's available balance cannot cover the debit or hold. The overdraft guard rejected it — no funds moved.",
      ),
    status: z.literal(409).describe("Conflict — the balance cannot cover the request."),
    ...publicFields,
  })
  .describe("An account cannot cover a debit or hold (409).");

const WalletHoldNotOpenPublic = z
  .object({
    code: z
      .literal("wallet/hold_not_open")
      .describe("The hold has already been released or captured, so it cannot be resolved again."),
    status: z.literal(409).describe("Conflict — the hold is already in a terminal state."),
    ...publicFields,
  })
  .describe("A hold that is already resolved cannot be resolved again (409).");

const WalletInvalidAmountPublic = z
  .object({
    code: z
      .literal("wallet/invalid_amount")
      .describe(
        "An amount was not a positive integer in the currency's minor unit. Amounts are never zero, negative, or fractional.",
      ),
    status: z.literal(400).describe("Bad Request — the amount is not a positive integer."),
    ...publicFields,
  })
  .describe("An amount is not a positive integer (400).");

// --- @pithy-sh/rating: skill-rating + experience tracker codes ---

const RatingUnknownAlgorithmPublic = z
  .object({
    code: z
      .literal("rating/unknown_algorithm")
      .describe(
        "A game wires a rating algorithm id that no one registered. Algorithm ids come from the built-ins (`elo`/`glicko`/`trueskill`) or `registerRatingAlgorithm`, not the database.",
      ),
    status: z.literal(400).describe("Bad Request — the adopter's config names an unregistered algorithm."),
    ...publicFields,
  })
  .describe("A game references an unregistered rating algorithm (400).");

const RatingUnsupportedPlayerCountPublic = z
  .object({
    code: z
      .literal("rating/unsupported_player_count")
      .describe(
        "A game's roster or team format is outside the algorithm's support — e.g. a 1v1-only algorithm (`elo`/`glicko`) wired to an N-player game, or a team format on an algorithm that cannot rate teams.",
      ),
    status: z.literal(400).describe("Bad Request — the algorithm cannot rate this game's shape."),
    ...publicFields,
  })
  .describe("An algorithm cannot rate a game's player count or team format (400).");

const RatingInvalidParamsPublic = z
  .object({
    code: z
      .literal("rating/invalid_params")
      .describe("A game's `algoParams` block failed the chosen algorithm's own validation."),
    status: z.literal(400).describe("Bad Request — the algorithm's tuning block is invalid."),
    ...publicFields,
  })
  .describe("A game's algorithm parameters failed validation (400).");

const RatingGameNotFoundPublic = z
  .object({
    code: z
      .literal("rating/game_not_found")
      .describe("No game with that key is configured. Game keys come from `pithy.config.ts`, not the database."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A requested rating game key is not configured (404).");

const RatingPoolNotFoundPublic = z
  .object({
    code: z.literal("rating/pool_not_found").describe("No rating pool with that name is configured by any game."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A requested rating pool is not configured (404).");

const RatingRecordForbiddenPublic = z
  .object({
    code: z
      .literal("rating/record_forbidden")
      .describe(
        "Recording a game's outcome requires the server-authoritative record scope. The authenticated caller does not hold it.",
      ),
    status: z.literal(403).describe("Forbidden — the caller may not record outcomes."),
    ...publicFields,
  })
  .describe("The caller lacks the scope to record a rated outcome (403).");

// --- @pithy-sh/matchmaking: pairing + presence capability codes ---

const MatchmakingRoomNotFoundPublic = z
  .object({
    code: z
      .literal("matchmaking/room_not_found")
      .describe("No open room has that code — it never existed, expired, or was already used up."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A room code resolves to no open room (404).");

const MatchmakingRoomFullPublic = z
  .object({
    code: z
      .literal("matchmaking/room_full")
      .describe("The room's code has already been redeemed its maximum number of times."),
    status: z.literal(409).describe("Conflict — the room code is spent."),
    ...publicFields,
  })
  .describe("A room code has no redemptions left (409).");

const MatchmakingInvalidCodePublic = z
  .object({
    code: z
      .literal("matchmaking/invalid_code")
      .describe("The supplied room code is malformed — wrong shape or length."),
    status: z.literal(400).describe("Bad Request — the code is not a valid room code."),
    ...publicFields,
  })
  .describe("A supplied room code is malformed (400).");

const MatchmakingInviteNotFoundPublic = z
  .object({
    code: z
      .literal("matchmaking/invite_not_found")
      .describe("No pending invite with that id exists, or it was already accepted, declined, or expired."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("A requested invite does not exist (404).");

const MatchmakingInviteForbiddenPublic = z
  .object({
    code: z
      .literal("matchmaking/invite_forbidden")
      .describe("The authenticated user is neither the inviter nor the invitee of this invite."),
    status: z.literal(403).describe("Forbidden — the invite is not yours to act on."),
    ...publicFields,
  })
  .describe("The caller may not act on this invite (403).");

const MatchmakingUserNotFoundPublic = z
  .object({
    code: z
      .literal("matchmaking/user_not_found")
      .describe(
        "The invited email or screen name resolves to no single user — no match, or an ambiguous display name. Invite by email for a unique identity.",
      ),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("An invite target resolves to no single user (404).");

const MatchmakingAlreadyFriendsPublic = z
  .object({
    code: z
      .literal("matchmaking/already_friends")
      .describe("The two users are already connected, or a request between them is already pending."),
    status: z.literal(409).describe("Conflict — the friendship or request already exists."),
    ...publicFields,
  })
  .describe("A friend connection or request already exists (409).");

const MatchmakingFriendRequestNotFoundPublic = z
  .object({
    code: z
      .literal("matchmaking/friend_request_not_found")
      .describe("No pending friend request exists between these users for the caller to accept or decline."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("No pending friend request exists (404).");

const MatchmakingNotQueuedPublic = z
  .object({
    code: z
      .literal("matchmaking/not_queued")
      .describe("The player is not currently waiting in this game's matchmaking queue."),
    status: z.literal(404).describe("Not Found."),
    ...publicFields,
  })
  .describe("The player is not in the queue (404).");

/**
 * The public projection of every error: the wire shape clients receive. No `detail`. Parsing
 * strips any stray `detail` (Zod drops unknown keys), so this schema is itself a guard against
 * internal context leaking outward.
 */
export const PublicErrorPayload = z
  .discriminatedUnion("code", [
    InvalidInputPublic,
    InvalidTokenPublic,
    ForbiddenPublic,
    NotFoundPublic,
    ConflictPublic,
    RateLimitPublic,
    InternalPublic,
    CloudflareNotConfiguredPublic,
    CloudflareRequestFailedPublic,
    CloudflareInvalidResponsePublic,
    SecretNotFoundPublic,
    SecretAlreadyExistsPublic,
    SecretInvalidValuePublic,
    SecretCryptoFailedPublic,
    EmailTemplateNotFoundPublic,
    EmailInvalidPayloadPublic,
    EmailInvalidTokenPublic,
    EmailSuppressedPublic,
    EmailRateLimitedPublic,
    EmailSendFailedPublic,
    TurnstileMissingTokenPublic,
    TurnstileFailedPublic,
    TurnstileConfigPublic,
    AuditInvalidEventPublic,
    AuditWriteFailedPublic,
    MediaNotFoundPublic,
    MediaUnsupportedPublic,
    MediaStorageFailedPublic,
    MediaEnrichmentFailedPublic,
    LeaderboardBoardNotFoundPublic,
    LeaderboardEntryNotFoundPublic,
    LeaderboardScoreRejectedPublic,
    LeaderboardSubmitForbiddenPublic,
    LeaderboardBoardImmutablePublic,
    LeaderboardInvalidSchedulePublic,
    MultiplayerGameNotFoundPublic,
    MultiplayerSessionNotFoundPublic,
    MultiplayerNotAMemberPublic,
    MultiplayerSessionFullPublic,
    MultiplayerInvalidTransitionPublic,
    MultiplayerInvalidMovePublic,
    WalletCurrencyNotFoundPublic,
    WalletAccountNotFoundPublic,
    WalletHoldNotFoundPublic,
    WalletInsufficientFundsPublic,
    WalletHoldNotOpenPublic,
    WalletInvalidAmountPublic,
    RatingUnknownAlgorithmPublic,
    RatingUnsupportedPlayerCountPublic,
    RatingInvalidParamsPublic,
    RatingGameNotFoundPublic,
    RatingPoolNotFoundPublic,
    RatingRecordForbiddenPublic,
    MatchmakingRoomNotFoundPublic,
    MatchmakingRoomFullPublic,
    MatchmakingInvalidCodePublic,
    MatchmakingInviteNotFoundPublic,
    MatchmakingInviteForbiddenPublic,
    MatchmakingUserNotFoundPublic,
    MatchmakingAlreadyFriendsPublic,
    MatchmakingFriendRequestNotFoundPublic,
    MatchmakingNotQueuedPublic,
  ])
  .describe("The public shape of every error Pithy emits — the closed set, safe for the wire.");
export type PublicErrorPayload = z.infer<typeof PublicErrorPayload>;

// The full members: each public member plus the internal `detail`. Built as explicit consts
// (not mapped) so the `code`-literal discriminated-union types survive for `Extract` narrowing.
const InvalidInput = InvalidInputPublic.extend(detailField).describe(InvalidInputPublic.description ?? "");
const InvalidToken = InvalidTokenPublic.extend(detailField).describe(InvalidTokenPublic.description ?? "");
const Forbidden = ForbiddenPublic.extend(detailField).describe(ForbiddenPublic.description ?? "");
const NotFound = NotFoundPublic.extend(detailField).describe(NotFoundPublic.description ?? "");
const Conflict = ConflictPublic.extend(detailField).describe(ConflictPublic.description ?? "");
const RateLimit = RateLimitPublic.extend(detailField).describe(RateLimitPublic.description ?? "");
const Internal = InternalPublic.extend(detailField).describe(InternalPublic.description ?? "");
const CloudflareNotConfigured = CloudflareNotConfiguredPublic.extend(detailField).describe(
  CloudflareNotConfiguredPublic.description ?? "",
);
const CloudflareRequestFailed = CloudflareRequestFailedPublic.extend(detailField).describe(
  CloudflareRequestFailedPublic.description ?? "",
);
const CloudflareInvalidResponse = CloudflareInvalidResponsePublic.extend(detailField).describe(
  CloudflareInvalidResponsePublic.description ?? "",
);
const SecretNotFound = SecretNotFoundPublic.extend(detailField).describe(SecretNotFoundPublic.description ?? "");
const SecretAlreadyExists = SecretAlreadyExistsPublic.extend(detailField).describe(
  SecretAlreadyExistsPublic.description ?? "",
);
const SecretInvalidValue = SecretInvalidValuePublic.extend(detailField).describe(
  SecretInvalidValuePublic.description ?? "",
);
const SecretCryptoFailed = SecretCryptoFailedPublic.extend(detailField).describe(
  SecretCryptoFailedPublic.description ?? "",
);
const EmailTemplateNotFound = EmailTemplateNotFoundPublic.extend(detailField).describe(
  EmailTemplateNotFoundPublic.description ?? "",
);
const EmailInvalidPayload = EmailInvalidPayloadPublic.extend(detailField).describe(
  EmailInvalidPayloadPublic.description ?? "",
);
const EmailInvalidToken = EmailInvalidTokenPublic.extend(detailField).describe(
  EmailInvalidTokenPublic.description ?? "",
);
const EmailSuppressed = EmailSuppressedPublic.extend(detailField).describe(EmailSuppressedPublic.description ?? "");
const EmailRateLimited = EmailRateLimitedPublic.extend(detailField).describe(EmailRateLimitedPublic.description ?? "");
const EmailSendFailed = EmailSendFailedPublic.extend(detailField).describe(EmailSendFailedPublic.description ?? "");
const TurnstileMissingToken = TurnstileMissingTokenPublic.extend(detailField).describe(
  TurnstileMissingTokenPublic.description ?? "",
);
const TurnstileFailed = TurnstileFailedPublic.extend(detailField).describe(TurnstileFailedPublic.description ?? "");
const TurnstileConfig = TurnstileConfigPublic.extend(detailField).describe(TurnstileConfigPublic.description ?? "");
const AuditInvalidEvent = AuditInvalidEventPublic.extend(detailField).describe(
  AuditInvalidEventPublic.description ?? "",
);
const AuditWriteFailed = AuditWriteFailedPublic.extend(detailField).describe(AuditWriteFailedPublic.description ?? "");
const MediaNotFound = MediaNotFoundPublic.extend(detailField).describe(MediaNotFoundPublic.description ?? "");
const MediaUnsupported = MediaUnsupportedPublic.extend(detailField).describe(MediaUnsupportedPublic.description ?? "");
const MediaStorageFailed = MediaStorageFailedPublic.extend(detailField).describe(
  MediaStorageFailedPublic.description ?? "",
);
const MediaEnrichmentFailed = MediaEnrichmentFailedPublic.extend(detailField).describe(
  MediaEnrichmentFailedPublic.description ?? "",
);
const LeaderboardBoardNotFound = LeaderboardBoardNotFoundPublic.extend(detailField).describe(
  LeaderboardBoardNotFoundPublic.description ?? "",
);
const LeaderboardEntryNotFound = LeaderboardEntryNotFoundPublic.extend(detailField).describe(
  LeaderboardEntryNotFoundPublic.description ?? "",
);
const LeaderboardScoreRejected = LeaderboardScoreRejectedPublic.extend(detailField).describe(
  LeaderboardScoreRejectedPublic.description ?? "",
);
const LeaderboardSubmitForbidden = LeaderboardSubmitForbiddenPublic.extend(detailField).describe(
  LeaderboardSubmitForbiddenPublic.description ?? "",
);
const LeaderboardBoardImmutable = LeaderboardBoardImmutablePublic.extend(detailField).describe(
  LeaderboardBoardImmutablePublic.description ?? "",
);
const LeaderboardInvalidSchedule = LeaderboardInvalidSchedulePublic.extend(detailField).describe(
  LeaderboardInvalidSchedulePublic.description ?? "",
);
const MultiplayerGameNotFound = MultiplayerGameNotFoundPublic.extend(detailField).describe(
  MultiplayerGameNotFoundPublic.description ?? "",
);
const MultiplayerSessionNotFound = MultiplayerSessionNotFoundPublic.extend(detailField).describe(
  MultiplayerSessionNotFoundPublic.description ?? "",
);
const MultiplayerNotAMember = MultiplayerNotAMemberPublic.extend(detailField).describe(
  MultiplayerNotAMemberPublic.description ?? "",
);
const MultiplayerSessionFull = MultiplayerSessionFullPublic.extend(detailField).describe(
  MultiplayerSessionFullPublic.description ?? "",
);
const MultiplayerInvalidTransition = MultiplayerInvalidTransitionPublic.extend(detailField).describe(
  MultiplayerInvalidTransitionPublic.description ?? "",
);
const MultiplayerInvalidMove = MultiplayerInvalidMovePublic.extend(detailField).describe(
  MultiplayerInvalidMovePublic.description ?? "",
);
const WalletCurrencyNotFound = WalletCurrencyNotFoundPublic.extend(detailField).describe(
  WalletCurrencyNotFoundPublic.description ?? "",
);
const WalletAccountNotFound = WalletAccountNotFoundPublic.extend(detailField).describe(
  WalletAccountNotFoundPublic.description ?? "",
);
const WalletHoldNotFound = WalletHoldNotFoundPublic.extend(detailField).describe(
  WalletHoldNotFoundPublic.description ?? "",
);
const WalletInsufficientFunds = WalletInsufficientFundsPublic.extend(detailField).describe(
  WalletInsufficientFundsPublic.description ?? "",
);
const WalletHoldNotOpen = WalletHoldNotOpenPublic.extend(detailField).describe(
  WalletHoldNotOpenPublic.description ?? "",
);
const WalletInvalidAmount = WalletInvalidAmountPublic.extend(detailField).describe(
  WalletInvalidAmountPublic.description ?? "",
);
const RatingUnknownAlgorithm = RatingUnknownAlgorithmPublic.extend(detailField).describe(
  RatingUnknownAlgorithmPublic.description ?? "",
);
const RatingUnsupportedPlayerCount = RatingUnsupportedPlayerCountPublic.extend(detailField).describe(
  RatingUnsupportedPlayerCountPublic.description ?? "",
);
const RatingInvalidParams = RatingInvalidParamsPublic.extend(detailField).describe(
  RatingInvalidParamsPublic.description ?? "",
);
const RatingGameNotFound = RatingGameNotFoundPublic.extend(detailField).describe(
  RatingGameNotFoundPublic.description ?? "",
);
const RatingPoolNotFound = RatingPoolNotFoundPublic.extend(detailField).describe(
  RatingPoolNotFoundPublic.description ?? "",
);
const RatingRecordForbidden = RatingRecordForbiddenPublic.extend(detailField).describe(
  RatingRecordForbiddenPublic.description ?? "",
);
const MatchmakingRoomNotFound = MatchmakingRoomNotFoundPublic.extend(detailField).describe(
  MatchmakingRoomNotFoundPublic.description ?? "",
);
const MatchmakingRoomFull = MatchmakingRoomFullPublic.extend(detailField).describe(
  MatchmakingRoomFullPublic.description ?? "",
);
const MatchmakingInvalidCode = MatchmakingInvalidCodePublic.extend(detailField).describe(
  MatchmakingInvalidCodePublic.description ?? "",
);
const MatchmakingInviteNotFound = MatchmakingInviteNotFoundPublic.extend(detailField).describe(
  MatchmakingInviteNotFoundPublic.description ?? "",
);
const MatchmakingInviteForbidden = MatchmakingInviteForbiddenPublic.extend(detailField).describe(
  MatchmakingInviteForbiddenPublic.description ?? "",
);
const MatchmakingUserNotFound = MatchmakingUserNotFoundPublic.extend(detailField).describe(
  MatchmakingUserNotFoundPublic.description ?? "",
);
const MatchmakingAlreadyFriends = MatchmakingAlreadyFriendsPublic.extend(detailField).describe(
  MatchmakingAlreadyFriendsPublic.description ?? "",
);
const MatchmakingFriendRequestNotFound = MatchmakingFriendRequestNotFoundPublic.extend(detailField).describe(
  MatchmakingFriendRequestNotFoundPublic.description ?? "",
);
const MatchmakingNotQueued = MatchmakingNotQueuedPublic.extend(detailField).describe(
  MatchmakingNotQueuedPublic.description ?? "",
);

/**
 * Every error Pithy can emit, in full: the public fields plus the internal `detail`. This is
 * what a `PithyError` carries in memory; the HTTP codec encodes it down to `PublicErrorPayload`.
 */
export const ErrorPayload = z
  .discriminatedUnion("code", [
    InvalidInput,
    InvalidToken,
    Forbidden,
    NotFound,
    Conflict,
    RateLimit,
    Internal,
    CloudflareNotConfigured,
    CloudflareRequestFailed,
    CloudflareInvalidResponse,
    SecretNotFound,
    SecretAlreadyExists,
    SecretInvalidValue,
    SecretCryptoFailed,
    EmailTemplateNotFound,
    EmailInvalidPayload,
    EmailInvalidToken,
    EmailSuppressed,
    EmailRateLimited,
    EmailSendFailed,
    TurnstileMissingToken,
    TurnstileFailed,
    TurnstileConfig,
    AuditInvalidEvent,
    AuditWriteFailed,
    MediaNotFound,
    MediaUnsupported,
    MediaStorageFailed,
    MediaEnrichmentFailed,
    LeaderboardBoardNotFound,
    LeaderboardEntryNotFound,
    LeaderboardScoreRejected,
    LeaderboardSubmitForbidden,
    LeaderboardBoardImmutable,
    LeaderboardInvalidSchedule,
    MultiplayerGameNotFound,
    MultiplayerSessionNotFound,
    MultiplayerNotAMember,
    MultiplayerSessionFull,
    MultiplayerInvalidTransition,
    MultiplayerInvalidMove,
    WalletCurrencyNotFound,
    WalletAccountNotFound,
    WalletHoldNotFound,
    WalletInsufficientFunds,
    WalletHoldNotOpen,
    WalletInvalidAmount,
    RatingUnknownAlgorithm,
    RatingUnsupportedPlayerCount,
    RatingInvalidParams,
    RatingGameNotFound,
    RatingPoolNotFound,
    RatingRecordForbidden,
    MatchmakingRoomNotFound,
    MatchmakingRoomFull,
    MatchmakingInvalidCode,
    MatchmakingInviteNotFound,
    MatchmakingInviteForbidden,
    MatchmakingUserNotFound,
    MatchmakingAlreadyFriends,
    MatchmakingFriendRequestNotFound,
    MatchmakingNotQueued,
  ])
  .describe("Every error Pithy can emit, with internal detail. The in-memory shape a PithyError carries.");
export type ErrorPayload = z.infer<typeof ErrorPayload>;

/** The closed set of machine-readable error codes. */
export type ErrorCode = ErrorPayload["code"];
