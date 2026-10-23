// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";
import type { UnmarkedString } from "@pithy-sh/core/src/privacy/types";

/**
 * `@pithy-sh/organization` throw sugar. The `organization/*` codes live in core's closed
 * `KitErrorPayload` union (CLAUDE.md §Errors); these subclasses are the package-local vehicles that set
 * one of those members. Runtime code in this package throws one of these, never a plain `new Error`.
 *
 * **The refusals are the security surface here, which is why they are a module rather than seven
 * literals.** A membership reaches whatever the tenant's data is, so what a refusal *says* is part of
 * the model: `organization/not_found` is one answer to two different facts on purpose, and that is a
 * property nothing may accidentally relax by throwing a more helpful error somewhere else.
 */

/** Variable parts each subclass accepts; `code`/`status` are fixed by the subclass. */
interface OrganizationErrorArgs {
  /** Override the public, safe-to-expose message. */
  message?: UnmarkedString;
  /** A remediation hint (CLI action line). */
  action?: UnmarkedString;
  /** Internal context for logs and audit. Never serialized to clients. */
  detail?: UnmarkedString;
  /** Values a translating client interpolates into its own wording for this code. */
  params?: MessageParams;
}

/**
 * No such organization — **or** none this caller belongs to.
 *
 * **One error for two facts, and this is the single most important line in the package.** A
 * distinguishable refusal is an existence oracle: a caller who can tell "does not exist" from "not
 * yours" can iterate ids and read out the customer list. So both paths throw this, with the identical
 * default message, and the difference is carried in `detail` — which the HTTP codec strips and the log
 * keeps, so an operator can still tell them apart and a client never can.
 *
 * The rule only holds if every producer uses it. `http/guard.ts` is the one place membership is
 * resolved, which is what makes that enforceable rather than hoped for.
 */
export class OrganizationNotFoundError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/not_found",
        status: 404,
        message: args.message ?? "That organization does not exist.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A proved member whose role does not hold the power the route asked for.
 *
 * **A 403 here, where {@link OrganizationNotFoundError} is a 404, and the difference is earned rather
 * than inconsistent.** By the time this is raised the caller has been proved a member, so they already
 * know the organization exists — they belong to it. Telling them their role is short leaks nothing
 * further, and it is the only answer that lets them go and ask somebody for the power.
 */
export class OrganizationForbiddenError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/forbidden",
        status: 403,
        message: args.message ?? "Your role in this organization does not allow that.",
        action: args.action ?? "Ask somebody who administers this organization.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A role catalog failed validation, at author time.
 *
 * Raised by `defineRoles`, so a redeclared kit power or an `administrativePower` nobody holds fails
 * where the catalog is written rather than the first time somebody is refused by it.
 */
export class OrganizationInvalidRoleCatalogError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/invalid_role_catalog",
        status: 400,
        message: args.message ?? "That role catalog is not valid.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * An invitation cannot be redeemed.
 *
 * **One code for five facts** — no such token, already used, withdrawn, expired, or presented by a
 * session whose own address is not the invited one. Telling somebody which it was tells whoever a link
 * was forwarded to exactly the same thing, and the address binding is the property that makes a
 * forwarded link useless.
 */
export class OrganizationInvitationInvalidError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/invitation_invalid",
        status: 400,
        message: args.message ?? "That invitation can no longer be accepted.",
        action: args.action ?? "Ask for a new one.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The write would leave the account with nobody holding `administrativePower`. */
export class OrganizationLastAdministratorError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/last_administrator",
        status: 409,
        message: args.message ?? "That would leave this organization with nobody who can administer it.",
        action: args.action ?? "Give somebody else an administering role first.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** Another organization already holds that slug. */
export class OrganizationSlugTakenError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/slug_taken",
        status: 409,
        message: args.message ?? "That short name is already taken.",
        action: args.action ?? "Pick another.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** No standing ownership offer this caller may accept. */
export class OrganizationNominationInvalidError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/nomination_invalid",
        status: 400,
        message: args.message ?? "There is no offer of ownership for you to accept.",
        action: args.action,
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * An operator's write would leave the account with no owner — the role a transfer of ownership confers.
 *
 * **Not {@link OrganizationLastAdministratorError}, because the way out is different.** The last
 * administrator is repaired by promoting somebody. The last owner is repaired by moving ownership, which
 * is its own route, so the refusal names it in `action` for the operator's log and in
 * `params.ownershipRoute` for the management client that has to render the next step.
 */
export class OrganizationLastOwnerError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/last_owner",
        status: 409,
        message: args.message ?? "That would leave this organization with nobody who owns it.",
        action: args.action ?? "Force ownership onto somebody else first.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** An operator tried to add somebody who is already in the account. `params.role` names what they hold. */
export class OrganizationAlreadyMemberError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/already_member",
        status: 409,
        message: args.message ?? "That person is already a member of this organization.",
        action: args.action ?? "Change their role instead.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The account is at its seat limit. `params.seatLimit` names it. */
export class OrganizationSeatLimitReachedError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/seat_limit_reached",
        status: 409,
        message: args.message ?? "This organization has no free seat.",
        action: args.action ?? "Free a seat, or raise the seat limit.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * The organization a request acts in is suspended (#623). `params.suspendedUntil` names when it ends by itself,
 * when it does.
 *
 * **A 403, and only ever to a proved member.** Somebody who is not in the organization still gets
 * {@link OrganizationNotFoundError}, so this tells nobody anything about an account they could not already see.
 * It is not {@link OrganizationForbiddenError}, because no role would let them: the screen to render says what
 * happened to the organization, and that their own account is fine.
 */
export class OrganizationSuspendedError extends PithyError {
  constructor(args: OrganizationErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "organization/organization_suspended",
        status: 403,
        message: args.message ?? "This organization is suspended. Your own account is not affected.",
        action: args.action ?? "Ask an owner of the organization, or the operator, to reinstate it.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
