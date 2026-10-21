// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
import { secrets_0003_reencryptions } from "@pithy-sh/secrets/src/migrations/0003_reencryptions";
import {
  fingerprintVersions,
  pendingReencryptions,
  REENCRYPTION_SETTLE_MS,
  versionFingerprint,
} from "@pithy-sh/secrets/src/rotation/reencryption";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { ensureJwksSealedUnderCurrent, reencryptJwks, resetJwksReencryption } from "./jwksReencryption";
import { AUTH_JWKS_DEPENDENT, AUTH_SESSION_SECRET } from "./secrets";

const ONE = "jwks-test-version-one-000000000000000000000";
const TWO = "jwks-test-version-two-000000000000000000000";
const versions = { currentVersion: "2", versions: { "1": ONE, "2": TWO } };
const config = (current: number) => ({
  keys: new Map([
    [1, ONE],
    [2, TWO],
  ]),
  currentVersion: current,
});

async function insertKey(id: string, privateKey: string): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_jwks (id, public_key, private_key, created_at) values (?, '{}', ?, '2026-10-18T00:00:00.000Z')",
  )
    .bind(id, JSON.stringify(privateKey))
    .run();
}

async function storedKey(id: string): Promise<string> {
  const row = await env.DB.prepare("select private_key from pithy_auth_jwks where id = ?")
    .bind(id)
    .first<{ private_key: string }>();
  return JSON.parse(row?.private_key ?? '""') as string;
}

beforeEach(async () => {
  for (const table of ["pithy_auth_jwks", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  for (const table of [
    "pithy_auth_accounts",
    "pithy_auth_devices",
    "pithy_auth_rate_limit",
    "pithy_auth_rotated_tokens",
    "pithy_auth_user_lifecycle",
    "pithy_auth_sessions",
    "pithy_auth_users",
    "pithy_auth_verifications",
  ]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  await env.SECRETS.prepare("drop table if exists pithy_secrets_reencryptions").run();
  await secrets_0003_reencryptions.up(createDatabase(env.SECRETS, secretsTables) as never);
  resetJwksReencryption();
});

afterEach(() => {
  resetJwksReencryption();
});

describe("reencryptJwks (#602)", () => {
  test("moves a key sealed under the previous version, and a bare one from before versions, under the current one", async () => {
    await insertKey("enveloped", await symmetricEncrypt({ key: config(1), data: "private-enveloped" }));
    await insertKey("bare", await symmetricEncrypt({ key: ONE, data: "private-bare" }));
    await insertKey("current", await symmetricEncrypt({ key: config(2), data: "private-current" }));

    expect(await reencryptJwks(authDatabase(env.DB), versions)).toEqual({ moved: 2, current: 1, unopenable: 0 });
    for (const [id, plain] of [
      ["enveloped", "private-enveloped"],
      ["bare", "private-bare"],
      ["current", "private-current"],
    ] as const) {
      const sealed = await storedKey(id);
      expect(sealed).toMatch(/^\$ba\$2\$/);
      // Opens with version 2 alone: version 1 can now be retired.
      expect(await symmetricDecrypt({ key: { keys: new Map([[2, TWO]]), currentVersion: 2 }, data: sealed })).toBe(
        plain,
      );
    }
  });

  test("a key no retained version opens is left exactly as it was, and counted", async () => {
    const foreign = await symmetricEncrypt({ key: "a-secret-nobody-here-holds-00000000000000", data: "lost" });
    await insertKey("lost", foreign);
    expect(await reencryptJwks(authDatabase(env.DB), versions)).toEqual({ moved: 0, current: 0, unopenable: 1 });
    expect(await storedKey("lost")).toBe(foreign);
  });

  test("a second pass moves nothing", async () => {
    await insertKey("enveloped", await symmetricEncrypt({ key: config(1), data: "private-enveloped" }));
    await reencryptJwks(authDatabase(env.DB), versions);
    expect(await reencryptJwks(authDatabase(env.DB), versions)).toEqual({ moved: 0, current: 1, unopenable: 0 });
  });
});

/** The fields one log line carried. */
type LogFields = Parameters<Logger["info"]>[1];

/** A logger that keeps what it was told. */
function recorder(): { log: Logger; lines: { level: string; msg: string; fields?: LogFields }[] } {
  const lines: { level: string; msg: string; fields?: LogFields }[] = [];
  const log: Logger = {
    debug: (msg, fields) => lines.push({ level: "debug", msg, ...(fields ? { fields } : {}) }),
    info: (msg, fields) => lines.push({ level: "info", msg, ...(fields ? { fields } : {}) }),
    warn: (msg, fields) => lines.push({ level: "warn", msg, ...(fields ? { fields } : {}) }),
    error: (msg, fields) => lines.push({ level: "error", msg, ...(fields ? { fields } : {}) }),
    child: () => log,
  };
  return { log, lines };
}

/** A secrets D1 that refuses every query, and counts how often it was asked. */
function refusingD1(): { db: D1Database; asked: () => number } {
  let asked = 0;
  const db = {
    prepare: () => {
      asked += 1;
      throw new Error("secrets D1 unavailable");
    },
    batch: () => {
      asked += 1;
      throw new Error("secrets D1 unavailable");
    },
  } as unknown as D1Database;
  return { db, asked: () => asked };
}

/** The re-encryption row, as the secrets D1 holds it. */
async function recordRow() {
  return await env.SECRETS.prepare(
    "select version, fingerprint, observed_at, moved_at from pithy_secrets_reencryptions where name = ? and dependent = ? and holder = ?",
  )
    .bind(AUTH_SESSION_SECRET, AUTH_JWKS_DEPENDENT, "DB")
    .first<{ version: string; fingerprint: string; observed_at: number; moved_at: number | null }>();
}

describe("ensureJwksSealedUnderCurrent (#602)", () => {
  const T0 = new Date("2026-10-18T03:00:00.000Z");
  const settled = new Date(T0.getTime() + REENCRYPTION_SETTLE_MS);

  test("with one version held there is nothing to move, and the database is recorded as a holder under it", async () => {
    await insertKey("enveloped", await symmetricEncrypt({ key: config(1), data: "private-enveloped" }));
    const { log, lines } = recorder();
    const sole = { currentVersion: "1", versions: { "1": ONE } };
    await ensureJwksSealedUnderCurrent({
      db: authDatabase(env.DB),
      holder: "DB",
      secrets: env.SECRETS,
      versions: sole,
      log,
      now: T0,
    });
    expect(await storedKey("enveloped")).toMatch(/^\$ba\$1\$/);
    expect(await recordRow()).toMatchObject({
      version: "1",
      fingerprint: await versionFingerprint(ONE),
      moved_at: T0.getTime(),
    });
    expect(lines).toEqual([]);
    // Once per isolate: the next request does not ask again.
    const { db, asked } = refusingD1();
    await ensureJwksSealedUnderCurrent({ db: authDatabase(env.DB), holder: "DB", secrets: db, versions: sole, log });
    expect(asked()).toBe(0);
  });

  test("two auth databases are two holders: the one that moved does not answer for the one that has not", async () => {
    const { log } = recorder();
    const secretsDb = createDatabase(env.SECRETS, secretsTables);
    // A second auth Worker, over its own database, served a request before the rotation.
    await ensureJwksSealedUnderCurrent({
      db: authDatabase(env.DB),
      holder: "COLLAB_DB",
      secrets: env.SECRETS,
      versions: { currentVersion: "1", versions: { "1": ONE } },
      log,
      now: T0,
    });
    const deps = { db: authDatabase(env.DB), holder: "DB", secrets: env.SECRETS, versions, log };
    await ensureJwksSealedUnderCurrent({ ...deps, now: T0 });
    await ensureJwksSealedUnderCurrent({ ...deps, now: settled });
    const fingerprints = await fingerprintVersions(versions.versions);
    expect(
      await pendingReencryptions(secretsDb, AUTH_SESSION_SECRET, [AUTH_JWKS_DEPENDENT], "2", fingerprints),
    ).toEqual([`${AUTH_JWKS_DEPENDENT}/COLLAB_DB`]);
  });

  test("waits out every reader's cache before it moves: an isolate still holding version 1 alone keeps opening", async () => {
    await insertKey("enveloped", await symmetricEncrypt({ key: config(1), data: "private-enveloped" }));
    const { log } = recorder();
    const deps = { db: authDatabase(env.DB), holder: "DB", secrets: env.SECRETS, versions, log };

    // The first request to see version 2 records the sighting, and moves nothing.
    await ensureJwksSealedUnderCurrent({ ...deps, now: T0 });
    expect(await storedKey("enveloped")).toMatch(/^\$ba\$1\$/);
    const stale = { keys: new Map([[1, ONE]]), currentVersion: 1 };
    expect(await symmetricDecrypt({ key: stale, data: await storedKey("enveloped") })).toBe("private-enveloped");
    expect(await recordRow()).toMatchObject({ version: "2", observed_at: T0.getTime(), moved_at: null });
    const fingerprints = await fingerprintVersions(versions.versions);
    expect(
      await pendingReencryptions(
        createDatabase(env.SECRETS, secretsTables),
        AUTH_SESSION_SECRET,
        [AUTH_JWKS_DEPENDENT],
        "2",
        fingerprints,
      ),
    ).toEqual([`${AUTH_JWKS_DEPENDENT}/DB`]);

    // Just short of the window, still nothing — a fresh isolate asks and is told to wait.
    resetJwksReencryption();
    await ensureJwksSealedUnderCurrent({ ...deps, now: new Date(settled.getTime() - 1) });
    expect(await storedKey("enveloped")).toMatch(/^\$ba\$1\$/);

    // Once every cache filled before the append has expired, the next request moves the keys and says so.
    resetJwksReencryption();
    await ensureJwksSealedUnderCurrent({ ...deps, now: settled });
    expect(await storedKey("enveloped")).toMatch(/^\$ba\$2\$/);
    expect(await recordRow()).toMatchObject({ version: "2", observed_at: T0.getTime(), moved_at: settled.getTime() });
    expect(
      await pendingReencryptions(
        createDatabase(env.SECRETS, secretsTables),
        AUTH_SESSION_SECRET,
        [AUTH_JWKS_DEPENDENT],
        "2",
        fingerprints,
      ),
    ).toEqual([]);
  });

  test("an isolate told to wait does not ask again until the window has passed", async () => {
    const { log } = recorder();
    await ensureJwksSealedUnderCurrent({
      db: authDatabase(env.DB),
      holder: "DB",
      secrets: env.SECRETS,
      versions,
      log,
      now: T0,
    });
    const { db, asked } = refusingD1();
    await ensureJwksSealedUnderCurrent({
      db: authDatabase(env.DB),
      holder: "DB",
      secrets: db,
      versions,
      log,
      now: new Date(T0.getTime() + 60_000),
    });
    expect(asked()).toBe(0);
    await expect(
      ensureJwksSealedUnderCurrent({
        db: authDatabase(env.DB),
        holder: "DB",
        secrets: db,
        versions,
        log,
        now: settled,
      }),
    ).resolves.toBeUndefined();
    expect(asked()).toBeGreaterThan(0);
  });

  test("once moved, this isolate does not ask again for that version", async () => {
    const { log } = recorder();
    const deps = { db: authDatabase(env.DB), holder: "DB", secrets: env.SECRETS, versions, log };
    await ensureJwksSealedUnderCurrent({ ...deps, now: T0 });
    await ensureJwksSealedUnderCurrent({ ...deps, now: settled });
    expect((await recordRow())?.moved_at).toBe(settled.getTime());
    const { db, asked } = refusingD1();
    await ensureJwksSealedUnderCurrent({ ...deps, secrets: db, now: new Date(settled.getTime() + 1) });
    expect(asked()).toBe(0);
  });

  test("the same version key under a new value is a new version: settled under the old one does not skip it", async () => {
    const { log } = recorder();
    const deps = { db: authDatabase(env.DB), holder: "DB", secrets: env.SECRETS, log };
    await ensureJwksSealedUnderCurrent({ ...deps, versions, now: T0 });
    await ensureJwksSealedUnderCurrent({ ...deps, versions, now: settled });

    // `update` replaced the value, and the cron appended again: "2" once more, and nothing like the last "2".
    const reset = {
      currentVersion: "2",
      versions: { "1": "reset-version-one-0000000000000000000000", "2": "reset-version-two-0000000000000000000000" },
    };
    const later = new Date(settled.getTime() + 86_400_000);
    await ensureJwksSealedUnderCurrent({ ...deps, versions: reset, now: later });
    expect(await recordRow()).toMatchObject({
      version: "2",
      fingerprint: await versionFingerprint(reset.versions["2"]),
      observed_at: later.getTime(),
      moved_at: null,
    });
  });

  test("never fatal: a secrets D1 that fails is logged, and the request goes on", async () => {
    await insertKey("enveloped", await symmetricEncrypt({ key: config(1), data: "private-enveloped" }));
    const { db } = refusingD1();
    const { log, lines } = recorder();
    await expect(
      ensureJwksSealedUnderCurrent({
        db: authDatabase(env.DB),
        holder: "DB",
        secrets: db,
        versions,
        log,
        now: settled,
      }),
    ).resolves.toBeUndefined();
    expect(lines.map((line) => line.level)).toEqual(["warn"]);
    expect(lines[0]?.msg).toMatch(/did not finish/);
    // The keys are where they were, and still open under the version they name.
    expect(await storedKey("enveloped")).toMatch(/^\$ba\$1\$/);
  });
});
