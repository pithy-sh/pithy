// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { DevicePlatform } from "../data/device";

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
    createdAt: z.iso.datetime().describe("When the user was created, ISO-8601."),
    updatedAt: z.iso.datetime().describe("When the row was last written, ISO-8601."),
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
export const AdminUserResponse = z
  .object({
    user: AdminUserView.describe("The user."),
    providers: z
      .array(z.string())
      .describe(
        "The OAuth providers linked to this account, as slugs. Read by a query that selects only `providerId`, so no provider token is ever loaded.",
      ),
    sessions: z.array(AdminSessionView).describe("Their live sessions, newest first, bounded."),
    sessionsTruncated: z
      .boolean()
      .describe("True when more sessions exist than the bound allowed. A pane must say so rather than imply a total."),
    devices: z.array(AdminDeviceView).describe("Their registered devices, most recently seen first, bounded."),
    devicesTruncated: z.boolean().describe("True when more devices exist than the bound allowed."),
  })
  .describe("One user with their live sessions, registered devices, and linked providers.");
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
