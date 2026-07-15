import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import { type DeviceMeta, deleteDevice, deviceSessionTokens, listDevices, registerDevice } from "./registry";

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
];

function meta(id: string, over: Partial<DeviceMeta> = {}): DeviceMeta {
  return { id, platform: "ios", name: null, model: null, osVersion: null, appVersion: null, pushToken: null, ...over };
}

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
});

describe("device registry", () => {
  test("registers a device and lists it back, decoded", async () => {
    const db = authDatabase(env.DB);
    await registerDevice(db, meta("dev-1", { name: "Ada's iPhone", pushToken: "apns-1" }), {
      userId: "user-1",
      lastIp: "203.0.113.7",
      now: new Date("2026-06-19T10:00:00.000Z"),
    });

    const devices = await listDevices(db, "user-1");
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: "dev-1",
      userId: "user-1",
      platform: "ios",
      name: "Ada's iPhone",
      pushToken: "apns-1",
      lastIp: "203.0.113.7",
    });
    expect(devices[0]?.lastSeenAt).toBeInstanceOf(Date);
  });

  test("a re-login upserts on (userId, id): refreshes lastSeen, keeps earlier metadata on a sparse login", async () => {
    const db = authDatabase(env.DB);
    await registerDevice(db, meta("dev-1", { name: "Ada's iPhone", pushToken: "apns-1" }), {
      userId: "user-1",
      lastIp: "203.0.113.7",
      now: new Date("2026-06-19T10:00:00.000Z"),
    });
    // Sparse re-login: no name/pushToken/platform supplied — must not wipe them or reset platform.
    await registerDevice(db, meta("dev-1", { platform: null }), {
      userId: "user-1",
      lastIp: "198.51.100.2",
      now: new Date("2026-06-20T10:00:00.000Z"),
    });

    const devices = await listDevices(db, "user-1");
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      name: "Ada's iPhone",
      pushToken: "apns-1",
      lastIp: "198.51.100.2",
      platform: "ios", // preserved — the sparse login carried no platform
    });
    expect(devices[0]?.lastSeenAt.toISOString()).toBe("2026-06-20T10:00:00.000Z");
    expect(devices[0]?.createdAt.toISOString()).toBe("2026-06-19T10:00:00.000Z"); // unchanged
  });

  test("the same device id under two users is two isolated rows", async () => {
    const db = authDatabase(env.DB);
    const now = new Date("2026-06-19T10:00:00.000Z");
    await registerDevice(db, meta("shared", { name: "user one" }), { userId: "user-1", lastIp: null, now });
    await registerDevice(db, meta("shared", { name: "user two" }), { userId: "user-2", lastIp: null, now });

    expect((await listDevices(db, "user-1"))[0]).toMatchObject({ name: "user one" });
    expect((await listDevices(db, "user-2"))[0]).toMatchObject({ name: "user two" });
  });

  test("deviceSessionTokens returns only the user's tokens for that device", async () => {
    const db = authDatabase(env.DB);
    const insertSession = (id: string, userId: string, deviceId: string | null) =>
      env.DB.prepare(
        "insert into pithy_auth_sessions (id, expires_at, token, created_at, updated_at, user_id, device_id) values (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          id,
          "2026-12-01T00:00:00.000Z",
          `tok-${id}`,
          "2026-06-19T00:00:00.000Z",
          "2026-06-19T00:00:00.000Z",
          userId,
          deviceId,
        )
        .run();
    await insertSession("s1", "user-1", "dev-1");
    await insertSession("s2", "user-1", "dev-1");
    await insertSession("s3", "user-1", "dev-2");
    await insertSession("s4", "user-2", "dev-1");

    expect((await deviceSessionTokens(db, "user-1", "dev-1")).sort()).toEqual(["tok-s1", "tok-s2"]);
  });

  test("deleteDevice removes only the targeted user's device", async () => {
    const db = authDatabase(env.DB);
    const now = new Date("2026-06-19T10:00:00.000Z");
    await registerDevice(db, meta("dev-1"), { userId: "user-1", lastIp: null, now });
    await registerDevice(db, meta("dev-1"), { userId: "user-2", lastIp: null, now });

    expect(await deleteDevice(db, "user-1", "dev-1")).toBe(true);
    expect(await listDevices(db, "user-1")).toHaveLength(0);
    expect(await listDevices(db, "user-2")).toHaveLength(1);
    expect(await deleteDevice(db, "user-1", "missing")).toBe(false);
  });
});
