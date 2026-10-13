// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Command } from "@pithy-sh/core/src/cli/command";
import type { KitErrorCode } from "@pithy-sh/core/src/error/payload";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { BROKEN_PIPE } from "./brokenPipe";

/**
 * **What a failed run's exit code says to do next (#697).**
 *
 * Every failure used to exit 1. A bad flag, a project nobody provisioned, a Cloudflare outage and a step
 * only a person may take all looked the same, so a script could only stop, and an agent could only guess
 * whether to fix its call, run something first, retry, or ask. Each kind now has its own number, and each
 * kit error code has exactly one kind — {@link EXIT_CLASS_BY_CODE}, checked against the union by the
 * compiler and by `exitClass.test.ts`.
 *
 * **It lives in the CLI, not on `ErrorPayload`.** An exit code is a fact about a process. A Worker that
 * throws the same `core/not_found` answers an HTTP request with it and never exits, and the 18 capability
 * error modules that mirror `ErrorArgs` have nothing to say about either. So the table is keyed on the code
 * the payload already carries, and `fix` rides beside the error (`withFix`) rather than inside it.
 */

/** The kinds of failure a script can act on differently. `docs/CLI.md` §3.8 publishes the table. */
export const ExitClass = z
  .enum(["failed", "usage", "precondition", "upstream", "person"])
  .describe(
    "What kind of failure ended the run: `usage` (fix the call), `precondition` (run the `fix` command first), `upstream` (retry with backoff), `person` (stop and ask), or `failed` (unclassified — read the error).",
  );
export type ExitClass = z.infer<typeof ExitClass>;

/** Every exit code the CLI uses on purpose. Compare against these, never against a literal. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  precondition: 3,
  upstream: 4,
  person: 5,
  interrupted: 130,
  brokenPipe: BROKEN_PIPE,
} as const;

/** One class's row, as `docs/CLI.md` and `pithy schema` publish it. */
export const ExitClassRow = z
  .object({
    exit: z.number().int().describe("The process exit code a run of this class ends with."),
    retryable: z.boolean().describe("Whether running the same command again, unchanged, can succeed."),
    meaning: z.string().describe("What went wrong, in a few words."),
    agentShould: z.string().describe("What a script or an agent should do on seeing this code."),
  })
  .describe("One exit class: its code, whether a retry can help, and what to do about it.");
export type ExitClassRow = z.infer<typeof ExitClassRow>;

/** The table, by class. `docs/CLI.md` §3.8 is pinned to it. */
export const EXIT_CLASSES: Record<ExitClass, ExitClassRow> = {
  failed: { exit: EXIT.failed, retryable: false, meaning: "Unclassified failure", agentShould: "Read the error" },
  usage: { exit: EXIT.usage, retryable: false, meaning: "Usage or validation", agentShould: "Fix the call" },
  precondition: {
    exit: EXIT.precondition,
    retryable: false,
    meaning: "Precondition unmet",
    agentShould: "Run the `fix` command",
  },
  upstream: {
    exit: EXIT.upstream,
    retryable: true,
    meaning: "Upstream or transient",
    agentShould: "Retry with backoff",
  },
  person: { exit: EXIT.person, retryable: false, meaning: "Needs a person", agentShould: "Stop and ask" },
};

/**
 * Every kit error code, and the one class it exits with.
 *
 * Mostly the HTTP status read as a remedy — 400 is the call, 401/403/404/409/410/412 are state that has to
 * change first, 429/502/503/504 are someone else's moment, 500 is ours — with the exceptions named where
 * they sit. `satisfies` makes a new kit code that nobody classified a type error in this package, before
 * any test runs.
 */
export const EXIT_CLASS_BY_CODE = {
  // Usage or validation (2): the call itself is wrong, and a different call fixes it.
  "audit/invalid_event": "usage",
  "core/invalid_workflow_params": "usage",
  "email/invalid_payload": "usage",
  "email/invalid_token": "usage",
  "input/required": "usage",
  "leaderboard/score_rejected": "usage",
  "ledger/invalid_amount": "usage",
  "matchmaking/invalid_code": "usage",
  "media/unsupported": "usage",
  "multiplayer/invalid_move": "usage",
  "organization/invalid_role_catalog": "usage",
  "organization/invitation_invalid": "usage",
  "organization/nomination_invalid": "usage",
  "payments/discount_invalid": "usage",
  "payments/entitlement_not_in_catalog": "usage",
  "payments/environment_mismatch": "usage",
  "payments/invalid_receipt": "usage",
  "payments/verification_failed": "usage",
  "rating/invalid_params": "usage",
  "rating/unknown_algorithm": "usage",
  "rating/unsupported_player_count": "usage",
  "secrets/invalid_value": "usage",
  "secrets/rotation_unsupported": "usage",
  "storage/quota_exceeded": "usage",
  "support/invalid_category": "usage",
  "support/unparseable_message": "usage",
  "testers/invalid_token": "usage",
  "turnstile/missing_token": "usage",
  "validation/invalid_input": "usage",
  "vector/dimension_mismatch": "usage",
  "vector/filter_too_large": "usage",
  "vector/metadata_too_large": "usage",
  "vector/topk_exceeded": "usage",
  "vector/unfilterable_field": "usage",
  // Precondition (3): the call is fine, and something it depends on is missing — not provisioned, no
  // credentials, nothing found where it was looked for. `cloudflare/not_configured` and
  // `cloudflare/request_failed` are here although their statuses say 500 and 502: the first is a missing
  // token or account id, and the second is Cloudflare's terminal answer to a 4xx — a grant the token lacks —
  // which `cloudflareRefusal` already separates from the transient 429s and 5xx that become `UpstreamError`.
  "auth/forbidden": "precondition",
  "auth/invalid_token": "precondition",
  "cloudflare/not_configured": "precondition",
  "cloudflare/request_failed": "precondition",
  "controlplane/insufficient_scope": "precondition",
  "controlplane/invalid_credential": "precondition",
  "controlplane/key_conflict": "precondition",
  "controlplane/key_not_found": "precondition",
  "controlplane/not_connected": "precondition",
  "core/conflict": "precondition",
  "core/not_found": "precondition",
  "core/precondition_failed": "precondition",
  "core/webhook_unverified": "precondition",
  "email/suppressed": "precondition",
  "email/template_not_found": "precondition",
  "leaderboard/board_immutable": "precondition",
  "leaderboard/board_not_found": "precondition",
  "leaderboard/entry_not_found": "precondition",
  "leaderboard/submit_forbidden": "precondition",
  "ledger/account_not_found": "precondition",
  "ledger/currency_not_found": "precondition",
  "ledger/hold_not_found": "precondition",
  "ledger/hold_not_open": "precondition",
  "ledger/insufficient_funds": "precondition",
  "matchmaking/already_friends": "precondition",
  "matchmaking/friend_request_not_found": "precondition",
  "matchmaking/invite_forbidden": "precondition",
  "matchmaking/invite_not_found": "precondition",
  "matchmaking/not_queued": "precondition",
  "matchmaking/room_full": "precondition",
  "matchmaking/room_not_found": "precondition",
  "matchmaking/user_not_found": "precondition",
  "media/not_found": "precondition",
  "multiplayer/game_not_found": "precondition",
  "multiplayer/invalid_transition": "precondition",
  "multiplayer/not_a_member": "precondition",
  "multiplayer/session_full": "precondition",
  "multiplayer/session_not_found": "precondition",
  "organization/forbidden": "precondition",
  "organization/last_administrator": "precondition",
  "organization/not_found": "precondition",
  "organization/slug_taken": "precondition",
  "payments/clawback_failed": "precondition",
  "payments/entitlement_required": "precondition",
  "payments/product_not_found": "precondition",
  "payments/rail_not_configured": "precondition",
  "payments/receipt_already_owned": "precondition",
  "payments/reconcile_not_provisioned": "precondition",
  "payments/subject_unresolved": "precondition",
  "payments/subscription_change_refused": "precondition",
  "payments/webhook_unverified": "precondition",
  "rating/game_not_found": "precondition",
  "rating/pool_not_found": "precondition",
  "rating/record_forbidden": "precondition",
  "secrets/already_exists": "precondition",
  "secrets/not_found": "precondition",
  "storage/forbidden": "precondition",
  "storage/not_found": "precondition",
  "storage/share_expired": "precondition",
  "storage/share_revoked": "precondition",
  "storage/upload_incomplete": "precondition",
  "support/not_found": "precondition",
  "testers/already_on_roster": "precondition",
  "testers/cohort_closed": "precondition",
  "testers/cohort_not_found": "precondition",
  "testers/copy_not_allowed": "precondition",
  "testers/member_not_found": "precondition",
  "testers/roster_full": "precondition",
  "testers/withdrawn": "precondition",
  "turnstile/failed": "precondition",
  "vector/index_not_found": "precondition",
  // Upstream or transient (4): a service the kit does not control failed or asked us to slow down. Three
  // are 500s by status and upstream by cause — enrichment, multipart assembly and classification each fail
  // inside a provider, and CLAUDE.md names them as the known exceptions to 502.
  "auth/provider_unavailable": "upstream",
  "core/upstream_failed": "upstream",
  "core/upstream_timeout": "upstream",
  "email/rate_limited": "upstream",
  "email/send_failed": "upstream",
  "media/enrichment_failed": "upstream",
  "media/storage_failed": "upstream",
  "payments/provider_unavailable": "upstream",
  "rate_limit/exceeded": "upstream",
  "storage/multipart_failed": "upstream",
  "support/classification_failed": "upstream",
  "support/rejected": "upstream",
  "support/reply_failed": "upstream",
  "testers/nudge_cooldown": "upstream",
  // Needs a person (5): a typed phrase, a manual command, a fresh sign-in, a credential rolled at its issuer
  // that the store never took. No automated retry or variation fixes these.
  "auth/session_not_fresh": "person",
  "core/person_required": "person",
  "secrets/rotation_unrecorded": "person",
  // Unclassified (1): the kit itself broke, or answered in a way nothing here can act on.
  "audit/write_failed": "failed",
  "cloudflare/invalid_response": "failed",
  "core/internal": "failed",
  "core/missing_workflow_binding": "failed",
  "core/unknown_workflow": "failed",
  "core/workflow_failed": "failed",
  "leaderboard/invalid_schedule": "failed",
  "secrets/crypto_failed": "failed",
  "testers/not_configured": "failed",
  "turnstile/config": "failed",
  "vector/metadata_index_drift": "failed",
} as const satisfies Record<KitErrorCode, ExitClass>;

/** Whether `code` is one the kit defines, rather than an adopter's own. */
function isKitCode(code: string): code is keyof typeof EXIT_CLASS_BY_CODE {
  return Object.hasOwn(EXIT_CLASS_BY_CODE, code);
}

/**
 * The class a payload exits with. An adopter's own code is `failed`: the kit cannot know what an
 * adopter's `billing/card_declined` asks of the caller, and borrowing a meaning from its status would
 * tell a script to retry something nobody said was transient.
 */
export function exitClassOf(payload: { readonly code: string }): ExitClass {
  return isKitCode(payload.code) ? EXIT_CLASS_BY_CODE[payload.code] : "failed";
}

/** The process exit code a payload ends the run with. */
export function exitCodeOf(payload: { readonly code: string }): number {
  return EXIT[exitClassOf(payload)];
}

/** The remedies attached by {@link withFix}, held beside the error so its payload stays core's shape. */
const FIXES = new WeakMap<PithyError, Command>();

/**
 * Attach the command that rights this failure, and hand the same error back so a throw site stays one
 * expression: `throw withFix(new PreconditionFailedError({ … }), provisionFix)`.
 *
 * **Only where the cause is known** (`docs/CONVENTIONS.md`): a `catch` that could be looking at anything
 * names no remedy. A `fix` is a whole `pithy` command an agent runs as written, so it takes a {@link Command}:
 * the one thing `@pithy-sh/core/src/cli/command.ts` makes, and only from a line that runs (#711). Prose cannot
 * be a `fix`, and neither can a command that destroys something — that builder makes neither.
 */
export function withFix<E extends PithyError>(error: E, fix: Command): E {
  FIXES.set(error, fix);
  return error;
}

/**
 * The remedy attached to `error`, if any. **Never for a person's step**: exit 5 exists so an agent stops,
 * and a runnable command beside it — the confirmation phrase, spelled out — would be an invitation not to.
 */
export function fixOf(error: PithyError): Command | undefined {
  if (exitClassOf(error.payload) === "person") return undefined;
  return FIXES.get(error);
}

/**
 * End the run because the person at the prompt canceled it: `Canceled.` on stderr and exit 130.
 *
 * `@clack/prompts` reads in raw mode, so Ctrl-C at a prompt comes back as a cancel rather than as SIGINT,
 * and the process would otherwise report an interrupt as an ordinary failure.
 */
export function canceled(): never {
  process.stderr.write("Canceled.\n");
  process.exit(EXIT.interrupted);
}
