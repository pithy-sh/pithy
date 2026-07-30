// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Device, DevicePlatform } from "../data/device";
import type { AuthDatabase } from "../data/tables";

/**
 * The device registry: parse optional device metadata off a sign-in request, upsert the
 * `pithy_auth_devices` row, and resolve a device's sessions for revocation. All writes go through our
 * shared Kysely + codecs (ms-epoch dates) — distinct from the Better-Auth-managed tables.
 */

/** Request headers a client may send at sign-in to register/identify its device. */
export const DEVICE_HEADERS = {
  id: "x-pithy-device-id",
  platform: "x-pithy-platform",
  name: "x-pithy-device-name",
  model: "x-pithy-device-model",
  osVersion: "x-pithy-os-version",
  appVersion: "x-pithy-app-version",
  pushToken: "x-pithy-push-token",
} as const;

/**
 * Device metadata captured at sign-in. `id` is required; everything else is best-effort. `platform` is
 * `null` when the header was absent — distinct from a supplied value — so a sparse re-login never
 * overwrites a known platform with a default.
 */
export interface DeviceMeta {
  id: string;
  platform: DevicePlatform | null;
  name: string | null;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  pushToken: string | null;
}

function header(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim();
  return value ? value : null;
}

/**
 * Parse device metadata from request headers. Returns `undefined` when no `x-pithy-device-id` is
 * present — a device-less login (a plain web session). `platform` is `null` when its header is absent
 * or unrecognized; the default `web` is applied only on first registration, never on a sparse update.
 */
export function parseDeviceMeta(headers: Headers): DeviceMeta | undefined {
  const id = header(headers, DEVICE_HEADERS.id);
  if (!id) return undefined;
  const platform = DevicePlatform.safeParse(header(headers, DEVICE_HEADERS.platform));
  return {
    id,
    platform: platform.success ? platform.data : null,
    name: header(headers, DEVICE_HEADERS.name),
    model: header(headers, DEVICE_HEADERS.model),
    osVersion: header(headers, DEVICE_HEADERS.osVersion),
    appVersion: header(headers, DEVICE_HEADERS.appVersion),
    pushToken: header(headers, DEVICE_HEADERS.pushToken),
  };
}

/**
 * Register-or-update a device for a user. Idempotent on the composite `(userId, id)` key: a re-login
 * from the same device refreshes `lastSeenAt`/`lastIp` and any newly-supplied metadata, but never
 * overwrites existing metadata with a sparse login and never resets `createdAt`.
 */
export async function registerDevice(
  db: AuthDatabase,
  meta: DeviceMeta,
  context: { userId: string; lastIp: string | null; now: Date },
): Promise<void> {
  const record = Device.encode({
    id: meta.id,
    userId: context.userId,
    // `web` is the default only at first registration; an update preserves the stored platform unless
    // the client supplied a fresh one (handled in `refreshed` below).
    platform: meta.platform ?? "web",
    name: meta.name,
    model: meta.model,
    osVersion: meta.osVersion,
    appVersion: meta.appVersion,
    pushToken: meta.pushToken,
    lastIp: context.lastIp,
    lastSeenAt: context.now,
    createdAt: context.now,
  });
  // Only refresh fields the client actually supplied this time, so a metadata-light re-login keeps
  // earlier richer detail.
  const refreshed: Record<string, unknown> = {
    lastSeenAt: record.lastSeenAt,
    lastIp: record.lastIp,
  };
  if (meta.platform !== null) refreshed.platform = record.platform;
  if (meta.name !== null) refreshed.name = record.name;
  if (meta.model !== null) refreshed.model = record.model;
  if (meta.osVersion !== null) refreshed.osVersion = record.osVersion;
  if (meta.appVersion !== null) refreshed.appVersion = record.appVersion;
  if (meta.pushToken !== null) refreshed.pushToken = record.pushToken;

  await db
    .insertInto("pithyAuthDevices")
    .values(record)
    .onConflict((oc) => oc.columns(["userId", "id"]).doUpdateSet(refreshed))
    .execute();
}

/** List a user's registered devices, most-recently-seen first. */
export async function listDevices(db: AuthDatabase, userId: string): Promise<Device[]> {
  const rows = await db
    .selectFrom("pithyAuthDevices")
    .selectAll()
    .where("userId", "=", userId)
    .orderBy("lastSeenAt", "desc")
    .execute();
  return rows.map((row) => Device.parse(row));
}

/** Resolve the session tokens bound to one of a user's devices — the set a device-revoke must sign out. */
export async function deviceSessionTokens(db: AuthDatabase, userId: string, deviceId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("pithyAuthSessions")
    .select("token")
    .where("userId", "=", userId)
    .where("deviceId", "=", deviceId)
    .execute();
  return rows.map((row) => row.token);
}

/** Delete a user's device row (after its sessions are revoked). Returns true if a row was removed. */
export async function deleteDevice(db: AuthDatabase, userId: string, deviceId: string): Promise<boolean> {
  const result = await db
    .deleteFrom("pithyAuthDevices")
    .where("userId", "=", userId)
    .where("id", "=", deviceId)
    .executeTakeFirst();
  return (result.numDeletedRows ?? 0n) > 0n;
}
