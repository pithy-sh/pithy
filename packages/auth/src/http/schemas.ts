// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";
import { DevicePlatform } from "../data/device";
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
