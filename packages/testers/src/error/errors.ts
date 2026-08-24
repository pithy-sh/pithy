// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";

/**
 * The `testers/*` throw vehicles.
 *
 * **An opt-in link, a tester's email address, and a cohort's roster belong in `detail`, never
 * `message`.** The HTTP codec strips `detail`, and that is the single security boundary — a public
 * opt-in route answers unauthenticated strangers, so anything it says is said to everyone. Every
 * default `message` below is written to be safe to hand a stranger, and every one of them is
 * deliberately incurious: `TestersInvalidTokenError` covers a malformed link, an expired one, a forged
 * signature, and a link naming a deleted cohort with the same words, so a caller holding a guess cannot
 * use the response to narrow it down.
 */

/** The variable parts every testers error accepts; the `code` and `status` are fixed by the subclass. */
interface TestersErrorArgs {
  message?: string;
  action?: string;
  detail?: string;
  /**
   * Values a translating client interpolates into its own wording for this code. Client-facing, so —
   * unlike `action` and `detail` — these cross the boundary with `message`.
   */
  params?: MessageParams;
}

/** No cohort answers to that id. */
export class TestersCohortNotFoundError extends PithyError {
  constructor(args: TestersErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "testers/cohort_not_found",
        status: 404,
        message: args.message ?? "No such cohort.",
        action: args.action ?? "List your cohorts with `pithy testers list` and retry with an id from there.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** No member of that cohort answers to that id or address. */
export class TestersMemberNotFoundError extends PithyError {
  constructor(args: TestersErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "testers/member_not_found",
        status: 404,
        message: args.message ?? "No such tester on that cohort.",
        action: args.action ?? "Check the roster with `pithy testers roster <cohort>`.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * The opt-in link failed verification, for any reason at all.
 *
 * One error for every failing step is the point. A stranger who guesses at a link should learn only
 * that it did not work — not whether the signature was wrong, whether it had expired, or whether the
 * cohort it named exists. `detail` carries the step for the log.
 */
export class TestersInvalidTokenError extends PithyError {
  constructor(args: TestersErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "testers/invalid_token",
        status: 400,
        message: args.message ?? "That confirmation link is no longer valid.",
        action: args.action ?? "Ask the developer who invited you to send a fresh invitation.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The cohort is at its roster cap. */
export class TestersRosterFullError extends PithyError {
  constructor(args: TestersErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "testers/roster_full",
        status: 409,
        message: args.message ?? "That cohort's roster is full.",
        action: args.action ?? "Remove a lapsed tester, or raise the cohort's maximum roster size.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** That address is already on the roster in a live state. */
export class TestersAlreadyOnRosterError extends PithyError {
  constructor(args: TestersErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "testers/already_on_roster",
        status: 409,
        message: args.message ?? "That tester is already on this cohort.",
        action: args.action ?? "Use resend to send them another invitation without losing their history.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** Every selected tester is inside the per-tester nudge cooldown, so nothing was sent. */
export class TestersNudgeCooldownError extends PithyError {
  constructor(args: TestersErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "testers/nudge_cooldown",
        status: 429,
        message: args.message ?? "Every one of those testers was nudged too recently.",
        action: args.action ?? "Wait for the cooldown to pass, or select testers who have not been nudged.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * The address withdrew from this cohort itself, so it may not be invited back onto it.
 *
 * `lapsed` has exactly one producer: the tester's own `POST /opt-out/:token`. It is therefore never a
 * roster state a developer chose — it is a person's decision, and the page they saw when they made it
 * says "you will not hear from this test again". Reviving them restored the row to `invited` with a
 * fresh token and a zeroed nudge count, and `POST /invite` sends by default, so one call re-mailed
 * somebody who had asked to be left alone and restarted the whole chase sequence against them.
 *
 * Every other send path already refused a lapsed member — `resend`, `nudge`, and the daily pass all
 * check. `invite` was the one that did not, and it is the path a routine contact-list re-import takes.
 *
 * `removed` stays revivable, deliberately: that is the developer's own act on their own roster, and
 * undoing it takes nobody's consent away.
 */
export class TestersWithdrawnError extends PithyError {
  constructor(args: TestersErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "testers/withdrawn",
        status: 409,
        message: args.message ?? "That tester asked to be taken off this test.",
        action:
          args.action ??
          "Their decision stands. Invite somebody else, or ask them directly and start a new cohort if they agree.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * The cohort is closed, so this operation would write to or send from a finished program.
 *
 * `closedAt` was stamped by `closeCohort` and then read by exactly one filter, so everything that did
 * not go through that filter carried on: the control-plane routes still invited, resent and nudged, and
 * `pithy testers run --cohort <closed>` still mailed and still wrote a snapshot. Both the CLI and the
 * schema's own description promise "nothing further is sent", and a promise enforced in one place is a
 * promise for one path.
 */
export class TestersCohortClosedError extends PithyError {
  constructor(args: TestersErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "testers/cohort_closed",
        status: 409,
        message: args.message ?? "That cohort is closed.",
        action: args.action ?? "Create a new cohort. A closed one keeps its history but sends nothing further.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The caller supplied nudge copy, but this deployment pins the shipped defaults. */
export class TestersCopyNotAllowedError extends PithyError {
  constructor(args: TestersErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "testers/copy_not_allowed",
        status: 403,
        message: args.message ?? "This deployment does not accept supplied nudge copy.",
        action: args.action ?? "Send the nudge without a subject or body, or enable nudges.allowCopyOverride.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The capability is composed but cannot complete this operation without more wiring. */
export class TestersNotConfiguredError extends PithyError {
  constructor(args: TestersErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "testers/not_configured",
        status: 500,
        message: args.message ?? "The testers capability is not fully configured.",
        action: args.action ?? "Complete the testers block in pithy.config.ts and redeploy.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
