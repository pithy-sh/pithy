// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Locale } from "@pithy-sh/core/src/i18n/locale";
import { z } from "zod";
import { DevicePlatform } from "../data/device";
import { VerificationState, VerificationType } from "../data/verificationOutcome";

/**
 * What the auth admin routes return, as Zod objects a management client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values for the same reason: a management client reading a customer's Worker is crossing a
 * trust boundary, its own rules require it to validate that response before rendering it, and a
 * TypeScript interface is erased before it can help. Every client that had only an interface
 * hand-wrote a mirror of these, and the mirror drifted the first time a field landed here.
 *
 * **No codecs, and no transform anywhere in this file.** These describe JSON on the wire, so parsing
 * one hands back exactly what went in — which is what lets `responses.test.ts` compare a parsed value
 * with the projection's output and fail on a field either side forgot. A `SQLiteDate` here would
 * decode an ISO string into a `Date` and make that comparison meaningless.
 *
 * The projections that fill these live in `views.ts`, which documents *why* a credential is absent
 * from each. This file is the shape; that file is the argument.
 *
 * **A field added here later is `.optional()`, not merely `.nullable()`.** This module is read across a
 * version boundary — a management client validates a response with this schema against a customer's
 * Worker at whatever kit version it is on — so an additive required key fails `safeParse` for everyone
 * below that release and takes the whole pane with it (#450). Absent then means *this Worker cannot
 * say*, which is a different fact from `null`.
 */

/** Where a page resumes, or the end of the list. */
const NextCursor = z
  .string()
  .nullable()
  .describe("Where the next page resumes. Null at the end of the list. Opaque — pass it back verbatim.");

/** How many sessions a revocation actually ended. */
const RevokedCount = z
  .number()
  .int()
  .min(0)
  .describe("How many sessions were revoked. Zero is a success: revoking nothing is the idempotent case.");

/** A user as a management client may see them. */
export const AdminUserView = z
  .object({
    id: z.string().describe("The user's id, as `pithy_auth_users.id` stores it."),
    email: z.string().describe("The user's email address. Personal data, and the point of a support pane."),
    name: z.string().describe("The display name from the provider profile or sign-up."),
    emailVerified: z.boolean().describe("Whether the address has been verified."),
    image: z.string().nullable().describe("The avatar URL from a social profile, or null."),
    // `Locale`, not a bare string: it is a plain schema with checks and no transform, so parsing a
    // response still hands back exactly what went in — which is what `responses.test.ts` compares.
    locale: Locale.nullable()
      .optional()
      .describe(
        "The reader's chosen language as a BCP-47 tag; null when they have never chosen one, and absent when the Worker that answered predates the field (#450).",
      ),
    createdAt: z.iso.datetime().describe("When the user was created, ISO-8601."),
    updatedAt: z.iso.datetime().describe("When the row was last written, ISO-8601."),
    // Where the account stands (#813), on the organization view's shape. Each optional: absent from a Worker
    // older than the field. No reason and no actor — the reason is on the trail, and the trail is audit's.
    state: z
      .enum(["active", "suspended", "deleted"])
      .optional()
      .describe(
        "Where the account stands now: `active`; `suspended`, refused until it is reinstated or its end passes; or `deleted`, refused and restorable until `purgeAfter`. A suspension whose end has passed reads `active`, as enforcement reads it. Absent when the Worker that answered predates the field.",
      ),
    suspendedUntil: z.iso
      .datetime()
      .nullable()
      .optional()
      .describe(
        "When a suspension in force ends by itself, ISO-8601. Null for one that lasts until a reinstatement, and in every other state. Absent when the Worker predates the field.",
      ),
    purgeAfter: z.iso
      .datetime()
      .nullable()
      .optional()
      .describe(
        "For a deleted account, when the purge may erase it, ISO-8601 — restorable until then. Null in every other state. Absent when the Worker predates the field.",
      ),
  })
  .describe("One user as a management client sees them. The table holds no credential, so nothing is withheld.");
export type AdminUserView = z.output<typeof AdminUserView>;

/** A session as a management client may see it — the token is not part of the contract. */
export const AdminSessionView = z
  .object({
    id: z.string().describe("The session's id — the handle `POST /admin/sessions/revoke` accepts. Not the token."),
    deviceId: z.string().nullable().describe("The device this session was created on, or null."),
    ipAddress: z.string().nullable().describe("Where the sign-in came from, or null. The field that catches a theft."),
    userAgent: z.string().nullable().describe("The client user-agent at sign-in, or null."),
    createdAt: z.iso.datetime().describe("When the session began, ISO-8601."),
    updatedAt: z.iso.datetime().describe("When it was last refreshed, ISO-8601."),
    expiresAt: z.iso.datetime().describe("When it lapses, ISO-8601."),
  })
  .describe("One session as a management client sees it — without the token, which is the credential itself.");
export type AdminSessionView = z.output<typeof AdminSessionView>;

/** A registered device as a management client may see it — the push token is not part of the contract. */
export const AdminDeviceView = z
  .object({
    id: z.string().describe("The client-generated device id it registered at sign-in."),
    userId: z.string().describe("The owning user's id."),
    platform: DevicePlatform.describe("The platform the device registered as."),
    name: z.string().nullable().describe("The device's human label, or null."),
    model: z.string().nullable().describe("The hardware model, or null."),
    osVersion: z.string().nullable().describe("The device OS version at last sign-in, or null."),
    appVersion: z.string().nullable().describe("The client app version at last sign-in, or null."),
    lastIp: z.string().nullable().describe("Where the device was last seen, or null."),
    lastSeenAt: z.iso.datetime().describe("When it was last seen, ISO-8601."),
    createdAt: z.iso.datetime().describe("When it first registered, ISO-8601."),
  })
  .describe("One registered device as a management client sees it — without the push token, which is a credential.");
export type AdminDeviceView = z.output<typeof AdminDeviceView>;

/** `GET {base}/admin/users`. */
export const AdminUsersResponse = z
  .object({
    users: z.array(AdminUserView).describe("The page, newest first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the user list.");
export type AdminUsersResponse = z.output<typeof AdminUsersResponse>;

/** `GET {base}/admin/users/:userId`. */
/**
 * A sub-read of the user pane that could not be made (#380).
 *
 * The pane fans out over three independent tables and this route used to `Promise.all` them: one D1 read
 * failing took the whole page down, so a support agent looking at a locked-out account saw a 500 instead
 * of the user and whichever lists did read.
 *
 * It carries **no rows and no reason**. No rows, because an empty array means *this user has none* and a
 * pane rendering "no active sessions" over a list nobody read is telling a support agent something that
 * was never established. No reason, because what a D1 read throws names a query and a table, and this
 * response crosses a trust boundary to a management client.
 */
const ListUnavailable = z
  .object({ state: z.literal("unavailable").describe("The list could not be read on this request.") })
  .describe("Nothing was established about this list. Deliberately empty — there is nothing here to render as 'none'.");

/** A bounded sub-list, behind its state: the rows and the truncation flag are unreachable without narrowing. */
const boundedList = <T extends z.ZodTypeAny>(items: T, what: string) =>
  z
    .discriminatedUnion("state", [
      z
        .object({
          state: z.literal("read").describe("The list was read."),
          items: z.array(items).describe(`${what} Empty means this user has none.`),
          truncated: z
            .boolean()
            .describe(
              "True when more rows exist than the bound allowed. A pane must say so rather than imply a total.",
            ),
        })
        .describe("The rows, and whether the bound cut them short."),
      ListUnavailable,
    ])
    .describe(`${what} Behind a state, so an unread list cannot be rendered as an empty one.`);

/** An unbounded sub-list, behind the same state. No truncation flag: this read has no bound to exceed. */
const wholeList = <T extends z.ZodTypeAny>(items: T, what: string) =>
  z
    .discriminatedUnion("state", [
      z
        .object({
          state: z.literal("read").describe("The list was read."),
          items: z.array(items).describe(`${what} Empty means this user has none.`),
        })
        .describe("The rows, in full."),
      ListUnavailable,
    ])
    .describe(`${what} Behind a state, so an unread list cannot be rendered as an empty one.`);

export const AdminUserResponse = z
  .object({
    user: AdminUserView.describe("The user."),
    providers: wholeList(
      z.string(),
      "The OAuth providers linked to this account, as slugs. Read by a query that selects only `providerId`, so no provider token is ever loaded.",
    ),
    sessions: boundedList(AdminSessionView, "Their live sessions, newest first, bounded."),
    devices: boundedList(AdminDeviceView, "Their registered devices, most recently seen first, bounded."),
  })
  .describe(
    "One user with their live sessions, registered devices, and linked providers. The user is the subject and its absence is a 404; the three lists are contributors, and one that will not read costs its own list and not the page (#380).",
  );
export type AdminUserResponse = z.output<typeof AdminUserResponse>;

/** `GET {base}/admin/devices`. */
export const AdminDevicesResponse = z
  .object({
    devices: z.array(AdminDeviceView).describe("The page, most recently seen first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the device registry.");
export type AdminDevicesResponse = z.output<typeof AdminDevicesResponse>;

/**
 * One sign-in link or code from the verification ledger (#829), as a management client sees it.
 *
 * Never the token and never the address: the ledger holds neither. The mail is named by its job id, which is how
 * a reader holding `email:jobs:read` joins this to a bounce, a deferral or a suppression.
 */
export const AdminVerificationView = z
  .object({
    verificationId: z.string().describe("The verification row that carries it. Opaque; not a credential."),
    type: VerificationType.describe("What was issued."),
    state: VerificationState.describe("Where it stood at the moment of the read."),
    userId: z
      .string()
      .nullable()
      .describe(
        "The account it signs in to — known at issue, or created by its use. Null for a sign-up nobody completed.",
      ),
    emailJobId: z
      .string()
      .nullable()
      .describe(
        "The `pithy_email_jobs` row that carried it, under `email:jobs:read`. Null when the email seam failed and nothing was queued.",
      ),
    issuedAt: z.iso.datetime().describe("When it was issued, ISO-8601."),
    expiresAt: z.iso.datetime().describe("When it stops working, used or not, ISO-8601."),
    usedAt: z.iso.datetime().nullable().describe("When it signed somebody in, ISO-8601, or null."),
  })
  .describe("One sign-in link or code: what it was, whose, the mail that carried it, and where it stands.");
export type AdminVerificationView = z.output<typeof AdminVerificationView>;

/** How many of one type were issued over the window, and where they stand. */
export const VerificationTypeCounts = z
  .object({
    type: VerificationType.describe("Which type these counts are for."),
    issued: z.number().int().min(0).describe("How many were issued in the window."),
    used: z.number().int().min(0).describe("How many of those signed somebody in."),
    expired: z.number().int().min(0).describe("How many ran out unused."),
    pending: z.number().int().min(0).describe("How many are unused and still work. The three add up to `issued`."),
  })
  .describe("One type's counts over the window, by state.");
export type VerificationTypeCounts = z.output<typeof VerificationTypeCounts>;

/**
 * `GET {base}/admin/verifications` (#829): the window it covered, the counts by type and state over all of it,
 * and a page of its rows, newest issue first.
 *
 * The counts cover every row in the window whatever the page or the filters say, and every type, with zeros —
 * so a pane reading "sign-in links: 0 issued" can tell it from a Worker that did not say.
 */
export const AdminVerificationsResponse = z
  .object({
    window: z
      .object({
        since: z.iso.datetime().describe("The window's start, inclusive, ISO-8601."),
        until: z.iso.datetime().describe("The window's end, exclusive, ISO-8601."),
      })
      .describe("The window of issue times the counts and the rows cover."),
    counts: z.array(VerificationTypeCounts).describe("Every type's counts over the whole window, by state."),
    verifications: z.array(AdminVerificationView).describe("The page of rows, newest issue first."),
    nextCursor: NextCursor,
  })
  .describe("The verification ledger over a window: counts by type and state, and the rows, paged.");
export type AdminVerificationsResponse = z.output<typeof AdminVerificationsResponse>;

/**
 * `POST {base}/admin/sessions/revoke` and `POST {base}/admin/users/:userId/sessions/revoke`.
 *
 * A count and nothing else, deliberately. Both routes are idempotent — revoking a session that has
 * already gone is a success — and neither caller holds a read scope, so the response must not say
 * whose session it was. The owning user reaches the audit trail instead.
 */
export const AdminRevokeResponse = z
  .object({ revoked: RevokedCount })
  .describe("How many sessions the revocation ended.");
export type AdminRevokeResponse = z.output<typeof AdminRevokeResponse>;

/** `POST {base}/admin/users/:userId/devices/revoke`. */
export const AdminDeviceRevokeResponse = z
  .object({
    revoked: RevokedCount,
    removed: z.boolean().describe("Whether a device row was deleted. False when the user had no such device."),
  })
  .describe("How many sessions the device revocation ended, and whether the registry row went with them.");
export type AdminDeviceRevokeResponse = z.output<typeof AdminDeviceRevokeResponse>;

/**
 * `POST {base}/admin/users/:userId/suspend` (#621).
 *
 * The suspension the account is now under, how many sessions ended with it, and whether the person was told.
 * Not the reason: the caller wrote it, the trail keeps it, and echoing it back would put it in one more place
 * a dashboard logs.
 */
export const AdminUserSuspendResponse = z
  .object({
    userId: z.string().describe("The account suspended, as `pithy_auth_users.id` stores it."),
    state: z.literal("suspended").describe("Where the account stands now. Every sign-in and refresh is refused."),
    outcome: z
      .enum(["suspended", "updated"])
      .describe(
        "`suspended` when this call suspended an account in good standing; `updated` when it was already suspended and this call restated the reason and the end.",
      ),
    suspendedAt: z.iso
      .datetime()
      .describe("When the suspension in force began, ISO-8601. A restatement keeps the original start."),
    suspendedUntil: z.iso
      .datetime()
      .nullable()
      .describe("When it ends by itself, ISO-8601, with nothing written to end it. Null lasts until a reinstatement."),
    sessionsRevoked: RevokedCount,
    mailed: z
      .boolean()
      .describe(
        "Whether the account-suspended mail was enqueued. False for `notify: false`, when the config turns it off, or when no email capability is composed.",
      ),
  })
  .describe("A suspended account: since when, until when, how many sessions it cost, and whether the person was told.");
export type AdminUserSuspendResponse = z.output<typeof AdminUserSuspendResponse>;

/**
 * `POST {base}/admin/users/:userId/reinstate` (#621).
 *
 * No session count: a reinstatement restores none. The person signs in again.
 */
export const AdminUserReinstateResponse = z
  .object({
    userId: z.string().describe("The account reinstated, as `pithy_auth_users.id` stores it."),
    state: z.literal("active").describe("Where the account stands now. It can sign in again."),
    outcome: z
      .enum(["reinstated", "unchanged"])
      .describe(
        "`reinstated` when this call lifted a suspension; `unchanged` when there was none in force — never suspended, or past its end — and nothing was written.",
      ),
    mailed: z
      .boolean()
      .describe(
        "Whether the account-reinstated mail was enqueued. Always false for `unchanged`, and on the same rule as a suspension's otherwise.",
      ),
  })
  .describe("A reinstated account, and whether the person was told. Its revoked sessions stay revoked.");
export type AdminUserReinstateResponse = z.output<typeof AdminUserReinstateResponse>;

/** When the purge may erase a deleted account, ISO-8601. */
const PurgeAfter = z.iso
  .datetime()
  .describe(
    "When the purge may erase the account, ISO-8601. It can be restored until then; a hard deletion's is the moment it was deleted.",
  );

/**
 * `DELETE {base}/admin/users/:userId` (#622).
 *
 * What the deletion left in force, how many sessions ended with it, whether the person was told, and what
 * became of the purge. Not the reason: the caller wrote it and the trail keeps it.
 */
export const AdminUserDeleteResponse = z
  .object({
    userId: z.string().describe("The account deleted, as `pithy_auth_users.id` stores it."),
    state: z.literal("deleted").describe("Where the account stands now. Every sign-in and refresh is refused."),
    mode: z.enum(["soft", "hard"]).describe("The mode this call ran in — `soft` unless the caller named `hard`."),
    outcome: z
      .enum(["deleted", "brought_forward", "unchanged"])
      .describe(
        "`deleted` when this call deleted an account in good standing; `brought_forward` when a hard deletion moved an already-deleted account's purge to now; `unchanged` when it was already deleted and there was nothing to move.",
      ),
    deletedAt: z.iso.datetime().describe("When the account was deleted, ISO-8601. Kept by a deletion brought forward."),
    purgeAfter: PurgeAfter,
    purge: z
      .enum(["scheduled", "started", "pending"])
      .describe(
        "`scheduled`: the daily purge erases it once `purgeAfter` passes. `started`: the purge Workflow was started by this call. `pending`: the purge is due and this Worker binds no purge Workflow to start, so it runs once one is bound.",
      ),
    sessionsRevoked: RevokedCount,
    mailed: z
      .boolean()
      .describe(
        "Whether the deletion-scheduled mail was enqueued. Always false for `hard`, whose mail the purge sends, for `notify: false`, and when the config turns it off.",
      ),
  })
  .describe("A deleted account: when, until when it can be restored, what became of the purge, and its sessions.");
export type AdminUserDeleteResponse = z.output<typeof AdminUserDeleteResponse>;

/**
 * `POST {base}/admin/users/:userId/restore` (#622). No session count: a restoration restores none.
 */
export const AdminUserRestoreResponse = z
  .object({
    userId: z.string().describe("The account restored, as `pithy_auth_users.id` stores it."),
    state: z
      .enum(["active", "suspended"])
      .describe(
        "Where the account stands now: `active`, or `suspended` when a suspension it was under before the deletion is still in force.",
      ),
    outcome: z
      .enum(["restored", "unchanged"])
      .describe("`restored` when this call restored a deleted account; `unchanged` when it was not deleted."),
  })
  .describe("A restored account, inside its purge window. Its revoked sessions stay revoked.");
export type AdminUserRestoreResponse = z.output<typeof AdminUserRestoreResponse>;

/** One provider link an account holds, as an export carries it — no provider token. */
const AuthExportProvider = z
  .object({
    providerId: z.string().describe("The sign-in provider's slug — `google`, `apple`, `github`."),
    createdAt: z.iso.datetime().describe("When the provider was linked, ISO-8601."),
  })
  .describe("One sign-in provider linked to the account. The provider's tokens are credentials and are not here.");

/** One transition in an account's history, as an export carries it — not who made it. */
const AuthExportTransition = z
  .object({
    action: z
      .string()
      .describe(
        "What happened: `suspended`, `reinstated`, `deleted`, `restored`, `purge_step`, `purge_retained`, `purge_failed`, `purged`.",
      ),
    actorType: z.string().describe("Who made it: `control-plane`, `user` (the account's holder), or `system`."),
    reason: z.string().nullable().describe("The reason given, in the words of whoever made the transition, or null."),
    suspendedUntil: z.iso.datetime().nullable().describe("For a suspension, when it ends by itself, ISO-8601."),
    createdAt: z.iso.datetime().describe("When it happened, ISO-8601."),
  })
  .describe(
    "One transition in the account's history. The operator's identity is theirs, not the person's, so it is not here.",
  );

/**
 * What `@pithy-sh/auth` holds about one account, as its purge contribution exports it (#622) — the `data` of
 * the `auth` entry in an export.
 *
 * The person's own data and none of their credentials: no session token, no provider token, no push token.
 * Every list is whole, because an export that stopped at a bound would answer an access request with part of
 * an answer.
 */
export const AuthUserExport = z
  .object({
    user: AdminUserView.extend({
      suspendedAt: z.iso.datetime().nullable().describe("When a suspension in force began, ISO-8601, or null."),
      suspendedUntil: z.iso.datetime().nullable().describe("When that suspension ends by itself, ISO-8601, or null."),
      deletedAt: z.iso.datetime().nullable().describe("When the account was deleted, ISO-8601, or null."),
      purgeAfter: z.iso.datetime().nullable().describe("When the purge may erase it, ISO-8601, or null."),
    }).describe("The account itself, with where it stands."),
    sessions: z.array(AdminSessionView).describe("Every live session, newest first. Without the tokens."),
    providers: z.array(AuthExportProvider).describe("Every linked sign-in provider."),
    devices: z
      .array(AdminDeviceView)
      .describe("Every registered device, most recently seen first. Without push tokens."),
    history: z.array(AuthExportTransition).describe("Every lifecycle transition, oldest first."),
    verifications: z
      .array(AdminVerificationView)
      .optional()
      .describe(
        "Every sign-in link and code the verification ledger records for the account, newest first (#829). Absent from a Worker that predates the ledger.",
      ),
    plugins: z
      .record(z.string(), z.array(z.record(z.string(), z.unknown())))
      .describe(
        "The account's rows in each table a composed Better Auth plugin created keyed by `userId` — two-factor, passkeys, API keys — keyed by table. Without a column that holds a credential. Empty when no such plugin is composed.",
      ),
  })
  .describe("Everything `@pithy-sh/auth` holds about one account, without a credential.");
export type AuthUserExport = z.output<typeof AuthUserExport>;

/** Fields every capability's export entry carries. */
const exportEntry = {
  capability: z.string().describe("The capability whose rows these are — the purge step that erases or keeps them."),
  summary: z.string().describe("What that capability's purge erases, anonymizes or keeps, in its own sentence."),
  disposition: z
    .enum(["erase", "retain"])
    .optional()
    .describe(
      "What a purge does with these rows: `erase` (erased or anonymized) or `retain` (kept, for the reason in `basis`) (#814). Absent from a Worker that predates it, where every entry is `erase`.",
    ),
  basis: z
    .string()
    .optional()
    .describe(
      "For a `retain` entry, why the rows are kept, in one sentence written for the person — `Kept for tax records.` Absent for `erase`.",
    ),
};

/** One capability's part of an export. */
const AdminUserExportEntry = z
  .discriminatedUnion("state", [
    z
      .object({
        ...exportEntry,
        state: z.literal("exported").describe("The capability answered."),
        data: z
          .record(z.string(), z.unknown())
          .describe(
            "What it holds about the account, in the shape that capability exports. `auth`'s is `AuthUserExport`. For a `retain` entry, the rows a purge keeps.",
          ),
      })
      .describe("A capability's rows about the account."),
    z
      .object({
        ...exportEntry,
        state: z
          .literal("not_exported")
          .describe(
            "The capability erases rows about the account and does not say how to export them. No kit capability answers it; an adopter's own may.",
          ),
      })
      .describe("A capability that holds rows it does not export. Ask its owner."),
    z
      .object({
        ...exportEntry,
        state: z.literal("unavailable").describe("The capability's rows could not be read on this request."),
      })
      .describe("Nothing was established about this capability's rows. Deliberately empty — it is not 'none'."),
  ])
  .describe("One capability's part of an export, behind a state, so an unread part cannot be taken for an empty one.");

/**
 * `GET {base}/admin/users/:userId/export` (#622).
 *
 * Everything the kit holds about one account — the answer to an access request. One entry per composed
 * capability that declares a purge contribution, in the order the purge runs them, each read on its own so
 * one that will not read costs its own entry and not the document.
 */
export const AdminUserExportResponse = z
  .object({
    subject: z
      .object({
        type: z.literal("user").describe("The kind of subject: one person's account."),
        id: z.string().describe("The account's id, as `pithy_auth_users.id` stores it."),
      })
      .describe("Who this export is about."),
    exportedAt: z.iso.datetime().describe("When the export was read, ISO-8601."),
    capabilities: z
      .array(AdminUserExportEntry)
      .describe("Every composed capability's part, in the order the purge erases them."),
  })
  .describe("Everything the kit holds about one account, from every composed capability, as one document.");
export type AdminUserExportResponse = z.output<typeof AdminUserExportResponse>;

/*
 * The routes a signed-in person calls on their own account. These are not read across the management
 * version boundary the admin schemas above are, but a client generated from the contract reads Workers on
 * older releases too, so the same rule holds: a field added here later is `.optional()`.
 */

/** `POST {base}/token/rotate`. */
export const TokenRotateResponse = z
  .object({
    accessToken: z
      .string()
      .describe(
        "A short-lived JWT for a service outside this Worker, which verifies it against `/jwks`. The kit's own routes do not accept it: send `refreshToken` as the bearer.",
      ),
    refreshToken: z
      .string()
      .describe(
        "The successor session token: the bearer credential for `Authorization: Bearer` on the kit's routes, and what the next rotation takes. The one presented is spent, and presenting it again past a short grace window revokes the whole family.",
      ),
    expiresAt: z.iso.datetime().describe("When the successor session lapses, ISO-8601."),
  })
  .describe(
    "The rotated credentials: the session token that replaces the one presented, and a JWT for outside verifiers.",
  );
export type TokenRotateResponse = z.output<typeof TokenRotateResponse>;

/** `POST {base}/handoff`. */
export const HandoffExchangeResponse = z
  .object({
    token: z
      .string()
      .describe(
        "The raw session token: the bearer credential for `Authorization: Bearer`, and the refresh credential `/token/rotate` takes. Hold it in secure storage.",
      ),
    expiresAt: z.iso.datetime().describe("When the session lapses unless it is rotated first, ISO-8601."),
  })
  .describe("The session a redirect sign-in made, handed to the native app that started it.");
export type HandoffExchangeResponse = z.output<typeof HandoffExchangeResponse>;

/** One of the caller's own registered devices. */
export const MyDeviceView = z
  .object({
    id: z.string().describe("The client-generated device id it registered at sign-in."),
    userId: z.string().describe("The owning user's id: always the caller's own."),
    platform: DevicePlatform.describe("The platform the device registered as."),
    name: z.string().nullable().describe("The device's human label, or null."),
    model: z.string().nullable().describe("The hardware model, or null."),
    osVersion: z.string().nullable().describe("The device OS version at last sign-in, or null."),
    appVersion: z.string().nullable().describe("The client app version at last sign-in, or null."),
    pushToken: z.string().nullable().describe("The APNs or FCM push token the device registered, or null."),
    lastIp: z.string().nullable().describe("The client IP at the device's most recent sign-in, or null."),
    lastSeenAt: z.iso.datetime().describe("When the device was last seen, ISO-8601."),
    createdAt: z.iso.datetime().describe("When the device first registered, ISO-8601."),
  })
  .describe("One device registered to the caller's own account.");
export type MyDeviceView = z.output<typeof MyDeviceView>;

/** `GET {base}/devices`. */
export const MyDevicesResponse = z
  .object({
    devices: z.array(MyDeviceView).describe("Every device registered to the caller, most recently seen first."),
  })
  .describe("The caller's own registered devices.");
export type MyDevicesResponse = z.output<typeof MyDevicesResponse>;

/** `POST {base}/devices/revoke`. */
export const MyDeviceRevokeResponse = z
  .object({ revoked: RevokedCount })
  .describe("How many of the device's sessions the revocation signed out. The device's row goes with them.");
export type MyDeviceRevokeResponse = z.output<typeof MyDeviceRevokeResponse>;

/**
 * `DELETE {base}/account` (#622) — the signed-in person deleted their own account. Always soft, on the
 * configured window. Their sessions end with it, this one included.
 */
export const AccountDeleteResponse = z
  .object({
    state: z.literal("deleted").describe("The account is deleted. This session and every other one has ended."),
    purgeAfter: PurgeAfter,
    mailed: z
      .boolean()
      .describe(
        "Whether the deletion-scheduled mail, with the purge date and how to ask for the account back, was sent.",
      ),
  })
  .describe("The caller's own account, deleted: when its data will be erased, and whether they were mailed.");
export type AccountDeleteResponse = z.output<typeof AccountDeleteResponse>;
