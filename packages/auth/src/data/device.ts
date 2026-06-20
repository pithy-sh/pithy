import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * `pithy_auth_devices` — the device registry, a Pithy-specific table with no Better-Auth equivalent.
 *
 * One row per user-device, keyed on a client-generated stable id so the same physical device maps to
 * one row across re-logins. Sessions link back via `pithy_auth_sessions.device_id`. This table is
 * written by Pithy code (the `session.create` hook and the device routes) through our shared Kysely,
 * so it keeps Pithy's house ms-epoch `SQLiteDate` — unlike the Better-Auth tables.
 */

/** The platform a device runs. `web` covers any browser; mobile carries richer metadata. */
export const DevicePlatform = z
  .enum(["ios", "android", "web"])
  .describe("The device platform: `ios`, `android`, or `web`.");
export type DevicePlatform = z.output<typeof DevicePlatform>;

/** One registered device. */
export const Device = z
  .object({
    id: z
      .string()
      .describe(
        "Primary key. A client-generated stable id (UUID) so one physical device maps to one row across re-logins.",
      ),
    userId: z
      .string()
      .describe("The owning user's id. Foreign key to `pithy_auth_users(id)`, ON DELETE CASCADE. Indexed."),
    platform: DevicePlatform.describe("The device platform, captured from login metadata."),
    name: z
      .string()
      .nullable()
      .describe("A human label for the device (OS device name), shown in device-management UI. Nullable."),
    model: z.string().nullable().describe("The hardware model, for device-management UI and support. Nullable."),
    osVersion: z.string().nullable().describe("The device OS version at last sign-in. Nullable."),
    appVersion: z.string().nullable().describe("The client app version at last sign-in. Nullable."),
    pushToken: z
      .string()
      .nullable()
      .describe("The APNs/FCM push token, stored for the future push capability and updatable. Nullable."),
    lastIp: z
      .string()
      .nullable()
      .describe("The client IP at the most recent sign-in, for `new sign-in from…` security signals. Nullable."),
    lastSeenAt: SQLiteDate.describe(
      "When this device was last seen (most recent sign-in). Ms-epoch in SQLite; a `Date` in app code.",
    ),
    createdAt: SQLiteDate.describe("When this device was first registered. Ms-epoch in SQLite; a `Date` in app code."),
  })
  .describe("A registered device in `pithy_auth_devices` — per-device sessions, security signals, and push routing.");
export type Device = z.output<typeof Device>;
