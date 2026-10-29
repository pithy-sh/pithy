// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";
import { DevicePlatform } from "../data/device";
import { VerificationState, VerificationType } from "../data/verificationOutcome";
import { MAX_REASON } from "../lifecycle/reason";

/**
 * The request schemas for the auth routes Pithy owns. Validation happens at the HTTP boundary
 * (CLAUDE.md §Zod), declared on the route line with `validate(target, Schema)` — so
 * reading `routes.ts` and `adminRoutes.ts` tells you what each route accepts without opening a handler.
 *
 * Only Pithy's own routes appear here. Everything under `basePath` that Better Auth owns validates
 * itself, behind a catch-all that must hand it an unread request body.
 *
 * Every schema below the first is a bound on something a **management client** chose. Verified is not
 * the same as trusted: a control-plane credential proves who is calling, not that their pagination is
 * sane, and a client with a bug asks for a million user rows exactly as easily as a hostile one does.
 */

/**
 * The body of `POST /devices/revoke` and of the admin `POST /admin/users/:userId/devices/revoke`.
 * `deviceId` is client-minted (it arrives as the `x-pithy-device-id` header at sign-in), so it is
 * bounded rather than shape-checked: a well-formed id that matches no row must still reach the handler,
 * which answers `{ revoked: 0 }`.
 */
export const RevokeDeviceBody = z
  .object({
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .describe("The id of the device to revoke — the client-generated id it registered at sign-in."),
  })
  .describe("The body identifying which device to revoke — the caller's own, or an admin-named user's.");
export type RevokeDeviceBody = z.output<typeof RevokeDeviceBody>;

/**
 * The body of `POST /handoff`: the one-time code a redirect sign-in left on the app's link, and the verifier whose
 * challenge the sign-in carried. Bounded rather than shape-checked, so a malformed code or verifier is refused, and
 * the code spent, by the same trade that refuses a spent code, with the same answer.
 */
export const HandoffExchangeBody = z
  .object({
    code: z
      .string()
      .min(1)
      .max(256)
      .describe("The one-time code from the `code` parameter of the deep link the sign-in returned to."),
    verifier: z
      .string()
      .min(1)
      .max(256)
      .describe(
        "The random verifier the app made before the sign-in started: 43 to 128 characters from `A-Z a-z 0-9 - . _ ~`, as RFC 7636 shapes it. Its S256 digest is the `handoff_challenge` the sign-in's `callbackURL` carried.",
      ),
  })
  .describe("The code a native app trades for its session after a redirect sign-in, with the verifier that binds it.");
export type HandoffExchangeBody = z.output<typeof HandoffExchangeBody>;

/** The providers a native app can sign in with through the system browser: every redirect provider auth offers. */
export const RedirectProvider = z
  .enum(["apple", "facebook", "github", "google", "microsoft"])
  .describe(
    "A sign-in provider that completes in the browser, by redirect. Whether this Worker enables it is its config's call.",
  );
export type RedirectProvider = z.output<typeof RedirectProvider>;

/**
 * The query of `GET /sign-in/social/start`, the address a native app opens in the system browser's sign-in sheet.
 * Bounded rather than shape-checked: the handler holds `callbackURL` to `trustedOrigins` and to carrying a
 * `handoff_challenge`, and Better Auth checks both URLs again when the sign-in starts.
 */
export const SocialSignInStartQuery = z
  .object({
    provider: RedirectProvider,
    callbackURL: z
      .string()
      .min(1)
      .max(2048)
      .describe(
        "The app's own link, in `trustedOrigins`, carrying the `handoff_challenge` the app made: where the sign-in returns with a one-time code.",
      ),
    errorCallbackURL: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        "Where a refused sign-in returns, with an `error` parameter. In `trustedOrigins`. Absent, a refusal lands on the auth error page.",
      ),
  })
  .describe(
    "A native redirect sign-in, started in the system browser so the provider's state cookie lands in its jar.",
  );
export type SocialSignInStartQuery = z.output<typeof SocialSignInStartQuery>;

/**
 * The user id in the path of every single-user admin route.
 *
 * Bounded rather than `.uuid()`: Better Auth's id generator is configurable and its default is not a
 * UUID, so a UUID shape here would 404 — as a 400 — every user in a project that changed it. The schema
 * constrains the string; the handler still does the lookup and raises its own `core/not_found`.
 */
export const UserIdParam = z
  .object({
    userId: z.string().min(1).max(255).describe("The user's id, as `pithy_auth_users.id` stores it."),
  })
  .describe("The path parameters of every admin route that names one user.");
export type UserIdParam = z.output<typeof UserIdParam>;

/** How many rows a paged admin listing returns, when the caller names a number. */
const PageLimit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .optional()
  .describe("How many rows to return. Bounded, because a verified client can still have a bug.");

/** Where a paged admin listing resumes. */
const PageCursorParam = z
  .string()
  .max(512)
  .optional()
  .describe("Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page.");

/** The user listing query. */
export const ListUsersQuery = z
  .object({
    search: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Free text matched against email and display name. `%` and `_` are escaped rather than treated as wildcards, so an address containing an underscore matches itself and nothing else.",
      ),
    cursor: PageCursorParam,
    limit: PageLimit,
  })
  .describe("The user listing query: what to search for, how many to return, and where to resume.");
export type ListUsersQuery = z.output<typeof ListUsersQuery>;

/** The device-registry listing query. */
export const ListDevicesQuery = z
  .object({
    userId: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Narrow to one user's devices. Absent walks the whole fleet, most-recently-seen first."),
    platform: DevicePlatform.optional().describe("Narrow to one platform."),
    cursor: PageCursorParam,
    limit: PageLimit,
  })
  .describe("The device-registry query: what to filter by, how many to return, and where to resume.");
export type ListDevicesQuery = z.output<typeof ListDevicesQuery>;

/** A window bound on the verification read: ISO-8601 with an offset, decoded to a `Date` here so no handler parses it. */
const WindowBound = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

/**
 * The verification ledger read's query (#829): a window of issue times, what to narrow it to, and where to resume.
 * Both bounds are optional — the last 30 days, ending now — and a window that ends before it starts is refused by
 * the handler, which is where the default is known.
 */
export const ListVerificationsQuery = z
  .object({
    since: WindowBound.optional().describe(
      "The window's start, inclusive, on issue time, ISO-8601. Defaults to 30 days before `until`.",
    ),
    until: WindowBound.optional().describe("The window's end, exclusive, on issue time, ISO-8601. Defaults to now."),
    type: VerificationType.optional().describe("Narrow the rows to one type. The counts always cover every type."),
    state: VerificationState.optional().describe(
      "Narrow the rows to one state, judged at the moment of the read. The counts always cover every state.",
    ),
    cursor: PageCursorParam,
    limit: PageLimit,
  })
  .describe("The verification ledger query: the window, what to narrow the rows to, how many, and where to resume.");
export type ListVerificationsQuery = z.output<typeof ListVerificationsQuery>;

/**
 * The body of `POST /admin/sessions/revoke`.
 *
 * A session **id**, never a session token. The token is the live credential — a management client that
 * could name one would be holding the thing it is revoking, and a route that accepted one would be an
 * oracle for whether a captured token is still valid. The id is the row's public handle, which is what
 * the read routes project.
 */
export const RevokeSessionBody = z
  .object({
    sessionId: z
      .string()
      .min(1)
      .max(255)
      .describe("The session's id, as the admin read routes report it. Not the session token."),
  })
  .describe("The body identifying which single session to revoke.");
export type RevokeSessionBody = z.output<typeof RevokeSessionBody>;

/**
 * Why an account's access is changing — required on both lifecycle routes (#621).
 *
 * Trimmed, then bounded by the same constant the transition enforces, so a reason the transition would refuse
 * is a 400 here rather than a conflict later. Required rather than defaulted: a suspension nobody explained is
 * a lockout the person cannot answer, and the trail would record nothing about why.
 */
const LifecycleReason = z
  .string()
  .trim()
  .min(1)
  .max(MAX_REASON)
  .describe(
    "Why, in a sentence written for the person. A suspension's reason is what every refused sign-in shows them.",
  );

/** Whether the person is mailed. */
const Notify = z
  .boolean()
  .optional()
  .describe(
    "Whether to mail the person. Absent is true. The config can turn a lifecycle mail off for every call; this turns it off for one.",
  );

/** The body of `POST /admin/users/:userId/suspend`. */
export const SuspendUserBody = z
  .object({
    reason: LifecycleReason,
    until: JsonDate.optional().describe(
      "When the suspension ends by itself, as an ISO-8601 timestamp. Must be in the future. Absent lasts until a reinstatement. Nothing is written when it passes.",
    ),
    notify: Notify,
  })
  .describe(
    "A suspension: why, until when, and whether to tell the person. Suspending a suspended account restates the reason and the end.",
  );
export type SuspendUserBody = z.output<typeof SuspendUserBody>;

/** The body of `POST /admin/users/:userId/reinstate`. */
export const ReinstateUserBody = z
  .object({ reason: LifecycleReason, notify: Notify })
  .describe("A reinstatement: why, and whether to tell the person. It restores no session.");
export type ReinstateUserBody = z.output<typeof ReinstateUserBody>;

/**
 * How a deletion runs (#622). `soft` is the default and the only thing an omission reaches: the account is shut
 * now and erased once the window closes, restorable until then. `hard` starts the purge at once, with no
 * window, and is reached only by naming it — a typo is a 400, never either mode.
 */
export const DeletionMode = z
  .enum(["soft", "hard"])
  .describe(
    "`soft` (the default): the account is shut now and its data erased once `retention.purgeAfterDays` have passed; it can be restored until then. `hard`: the purge starts now, with no window and nothing to restore.",
  );
export type DeletionMode = z.output<typeof DeletionMode>;

/** The body of `DELETE /admin/users/:userId`. */
export const DeleteUserBody = z
  .object({
    mode: DeletionMode.default("soft").describe(
      "`soft` unless named: the window, then the purge. `hard` purges now. Anything else is refused.",
    ),
    reason: LifecycleReason,
    notify: z
      .boolean()
      .optional()
      .describe(
        "Whether to mail the person. Absent is true. It silences the mail this call sends: the deletion-scheduled notice for `soft`, the deletion-complete notice for `hard`.",
      ),
  })
  .describe("A deletion: soft or hard, why, and whether to tell the person.");
export type DeleteUserBody = z.output<typeof DeleteUserBody>;

/** The body of `POST /admin/users/:userId/restore`. */
export const RestoreUserBody = z
  .object({ reason: LifecycleReason })
  .describe("A restoration inside the purge window: why. It restores no session; the person signs in again.");
export type RestoreUserBody = z.output<typeof RestoreUserBody>;

/**
 * The query of `GET /admin/users/:userId/export`. A disclosure of everything the kit holds about one person
 * says why, like every lifecycle call: the reason goes on the trail beside who asked.
 */
export const ExportUserQuery = z
  .object({
    reason: LifecycleReason.describe(
      "Why this person's data is being exported — the access request it answers. Recorded on the audit trail.",
    ),
  })
  .describe("An export: why it is being made.");
export type ExportUserQuery = z.output<typeof ExportUserQuery>;

/**
 * The body of `DELETE /account`, the signed-in person deleting their own account (#622).
 *
 * The confirmation is the literal `true`, so a client must say it on purpose: a stray `DELETE` with an empty
 * body, or a form posting `"false"`, deletes nothing. There is no field naming an account — the subject is the
 * session's own, always — and a key that tries is dropped.
 */
export const DeleteAccountBody = z
  .object({
    confirm: z
      .literal(true)
      .describe("Must be `true`. The person confirmed, in your app, that they want their account deleted."),
  })
  .describe("A self-service deletion: the person's own confirmation. Always soft, on the configured window.");
export type DeleteAccountBody = z.output<typeof DeleteAccountBody>;
