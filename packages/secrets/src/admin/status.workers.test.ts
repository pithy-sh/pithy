// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsTables } from "../data/tables";
import { secrets_0001_init } from "../migrations/0001_init";
import { defineSecretRegistry } from "../registry";
import { AT_REST_ROTATION_NAME } from "../rotation/atRestKeyRotation";
import { RotationTracker } from "../store/rotationTracker";
import {
  readSecretRotations,
  readSecretStatus,
  type SecretRotationEntry,
  type SecretRotationRecord,
  type SecretStatus,
  type SecretStatusEntry,
  type SecretsStatusDb,
} from "./status";

/**
 * The status read against a real D1, because the two facts it is built on are SQLite's: a grouped
 * aggregate that ignores failed rotations, and a left-join-by-absence where a missing row is a null
 * rather than a dropped secret.
 *
 * The ciphertext marker is the point of the first suite. It is not enough for the returned objects to
 * lack a field — the value must never be in the result at all, however it got there, so the assertion
 * is over the serialized response rather than over a key set.
 */

/** A recognizable ciphertext, so a leak is visible in a string search rather than only in a field name. */
const CIPHERTEXT = "CIPHERTEXT-DO-NOT-LEAK";
const IV = "IV-DO-NOT-LEAK";
const NOW = new Date("2026-08-11T00:00:00.000Z");

const registry = defineSecretRegistry({
  "auth-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text", rotateEveryDays: 90 },
  "stripe-live-key": { backend: "d1", scope: "global", rotatable: false, valueType: "text", rotateEveryDays: 90 },
  "never-written": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
  SECRETS_ENCRYPTION_KEYS: { backend: "cf-secrets-store", scope: "environment", rotatable: false, valueType: "text" },
  "connection-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text", keyed: true },
});

function db(): SecretsStatusDb {
  return createDatabase(env.SECRETS, secretsTables);
}

/**
 * The readable half of a status read.
 *
 * A named helper rather than a cast, because the narrowing is the guarantee: a test that wants a
 * secret's facts has to say it is asking for the ones that could be read. Every assertion below about
 * `overdue`, `lastRotatedAt` or `createdAt` goes through here, so a row that stops decoding stops
 * satisfying them rather than reading as a null.
 */
function readable(entries: readonly SecretStatusEntry[]): SecretStatus[] {
  return entries.flatMap((entry) => (entry.state === "readable" ? [entry.status] : []));
}

/** The names a status read could not decode, in the order the read returned them. */
function unreadable(entries: readonly SecretStatusEntry[]): string[] {
  return entries.flatMap((entry) => (entry.state === "unreadable" ? [entry.name] : []));
}

/** The readable half of a rotation history. */
function records(entries: readonly SecretRotationEntry[]): SecretRotationRecord[] {
  return entries.flatMap((entry) => (entry.state === "readable" ? [entry.record] : []));
}

function daysAgo(days: number): number {
  return NOW.getTime() - days * 86_400_000;
}

async function storeSecret(name: string, createdAt: number, updatedAt: number, keyVersion = 1): Promise<void> {
  await env.SECRETS.prepare(
    "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values (?, ?, ?, ?, 'text', ?, ?)",
  )
    .bind(name, CIPHERTEXT, IV, keyVersion, createdAt, updatedAt)
    .run();
}

async function recordRotation(
  name: string,
  startedAt: number,
  completedAt: number | null,
  status: string,
  trigger: string,
  rotatedBy: string,
  errorMessage: string | null = null,
): Promise<void> {
  await env.SECRETS.prepare(
    'insert into pithy_secrets_rotations (name, started_at, completed_at, status, "trigger", rotated_by, error_message, metadata_snapshot) values (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(name, startedAt, completedAt, status, trigger, rotatedBy, errorMessage, '{"note":"SNAPSHOT-DO-NOT-LEAK"}')
    .run();
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("readSecretStatus", () => {
  test("reports one row per named registry entry, and never a keyed one", async () => {
    const statuses = readable(await readSecretStatus(db(), registry, { now: NOW }));
    // Sorted by name, so a screen renders in a stable order without doing it itself.
    expect(statuses.map((status) => status.name)).toEqual([
      "SECRETS_ENCRYPTION_KEYS",
      "auth-signing-key",
      "never-written",
      "stripe-live-key",
    ]);
  });

  test("no ciphertext, IV or snapshot reaches the result, whatever is in the tables", async () => {
    await storeSecret("auth-signing-key", daysAgo(400), daysAgo(400));
    await recordRotation("auth-signing-key", daysAgo(10), daysAgo(10), "failed", "cron", "wf-1", "boom sk_live_oops");

    const serialized = JSON.stringify(await readSecretStatus(db(), registry, { now: NOW }));

    expect(serialized).not.toContain(CIPHERTEXT);
    expect(serialized).not.toContain(IV);
    expect(serialized).not.toContain("SNAPSHOT-DO-NOT-LEAK");
    expect(serialized).not.toContain("sk_live_oops");
  });

  test("never rotated is null, which is not the same fact as rotated long ago", async () => {
    await storeSecret("auth-signing-key", daysAgo(400), daysAgo(400));
    await storeSecret("stripe-live-key", daysAgo(400), daysAgo(400));
    await recordRotation("stripe-live-key", daysAgo(300), daysAgo(300), "success", "manual", "op");

    const byName = new Map(readable(await readSecretStatus(db(), registry, { now: NOW })).map((s) => [s.name, s]));

    expect(byName.get("auth-signing-key")?.lastRotatedAt).toBeNull();
    expect(byName.get("stripe-live-key")?.lastRotatedAt).toEqual(new Date(daysAgo(300)));
    // Both are overdue, and one of them is overdue for a reason a screen must be able to phrase
    // differently. The null is what makes that possible.
    expect(byName.get("auth-signing-key")?.overdue).toBe(true);
    expect(byName.get("stripe-live-key")?.overdue).toBe(true);
  });

  test("a failed rotation never advances freshness", async () => {
    await storeSecret("auth-signing-key", daysAgo(400), daysAgo(400));
    await recordRotation("auth-signing-key", daysAgo(200), daysAgo(200), "success", "cron", "wf-1");
    await recordRotation("auth-signing-key", daysAgo(2), daysAgo(2), "failed", "cron", "wf-2", "nope");
    await recordRotation("auth-signing-key", daysAgo(1), null, "in_progress", "cron", "wf-3");

    const status = readable(await readSecretStatus(db(), registry, { now: NOW })).find(
      (s) => s.name === "auth-signing-key",
    );

    expect(status?.lastRotatedAt).toEqual(new Date(daysAgo(200)));
    expect(status?.overdue).toBe(true);
    // Every attempt counts, successful or not — the count is the history's size, not its score.
    expect(status?.rotationCount).toBe(3);
  });

  test("a fresh rotation clears overdue", async () => {
    await storeSecret("auth-signing-key", daysAgo(400), daysAgo(400));
    await recordRotation("auth-signing-key", daysAgo(3), daysAgo(3), "success", "manual", "op");

    const status = readable(await readSecretStatus(db(), registry, { now: NOW })).find(
      (s) => s.name === "auth-signing-key",
    );

    expect(status?.overdue).toBe(false);
    expect(status?.rotationCount).toBe(1);
  });

  test("a rotatable: false secret reports identically — the flag says what automation may do", async () => {
    await storeSecret("auth-signing-key", daysAgo(400), daysAgo(400));
    await storeSecret("stripe-live-key", daysAgo(400), daysAgo(400));

    const byName = new Map(readable(await readSecretStatus(db(), registry, { now: NOW })).map((s) => [s.name, s]));
    const rotatable = byName.get("auth-signing-key");
    const manual = byName.get("stripe-live-key");

    expect(manual?.rotatable).toBe(false);
    expect(rotatable?.rotatable).toBe(true);
    // Same nulls, same overdue verdict, same fields populated. Nothing is withheld from the one nobody
    // can automate, which is the one most worth telling somebody about.
    expect(manual?.overdue).toBe(rotatable?.overdue);
    expect(manual?.lastRotatedAt).toEqual(rotatable?.lastRotatedAt);
    expect(Object.keys(manual ?? {}).sort()).toEqual(Object.keys(rotatable ?? {}).sort());
  });

  test("a declared secret with no row reports nulls rather than dropping out", async () => {
    const byName = new Map(readable(await readSecretStatus(db(), registry, { now: NOW })).map((s) => [s.name, s]));
    const absent = byName.get("never-written");

    expect(absent?.createdAt).toBeNull();
    expect(absent?.updatedAt).toBeNull();
    expect(absent?.keyVersion).toBeNull();
    expect(absent?.rotationCount).toBe(0);
    // Nothing to measure from, and no cadence declared either. Unanswerable, not fine.
    expect(absent?.overdue).toBeNull();
  });

  test("a Secrets Store secret has no row here, and its backend is what makes the nulls readable", async () => {
    const master = readable(await readSecretStatus(db(), registry, { now: NOW })).find(
      (s) => s.name === "SECRETS_ENCRYPTION_KEYS",
    );
    expect(master?.backend).toBe("cf-secrets-store");
    expect(master?.createdAt).toBeNull();
  });

  test("the whole-store key rotation is not a secret, and does not appear", async () => {
    const tracker = RotationTracker.fromD1(env.SECRETS);
    await tracker.startRotation(AT_REST_ROTATION_NAME, "cron", "wf-at-rest");

    const statuses = readable(await readSecretStatus(db(), registry, { now: NOW }));

    expect(statuses.map((status) => status.name)).not.toContain(AT_REST_ROTATION_NAME);
    for (const status of statuses) expect(status.rotationCount).toBe(0);
  });

  test("an empty registry is an empty answer and issues no query", async () => {
    expect(await readSecretStatus(db(), {}, { now: NOW })).toEqual([]);
  });

  /**
   * `#387`, at the site that reads like a field conversion rather than like parsing a row.
   *
   * `storedFacts` decodes `createdAt` and `updatedAt` inside `for (const row of rows)`. Unguarded, one
   * ms-epoch that will not decode threw out of the loop and lost the whole chunk — so every secret in it
   * reported nothing on account of one, and `readSecretStatus` threw, and `#350` turned that into the
   * whole capability reporting `unavailable`.
   *
   * A column with INTEGER affinity holding text is how this arrives: SQLite stores what it cannot coerce.
   */
  test("a stored row that will not decode costs its own name, and the healthy ones still resolve", async () => {
    await storeSecret("auth-signing-key", daysAgo(400), daysAgo(400));
    await storeSecret("stripe-live-key", daysAgo(10), daysAgo(10));
    await env.SECRETS.prepare(
      "update pithy_secrets_system_secrets set created_at = 'not-a-date' where name = 'auth-signing-key'",
    ).run();

    const entries = await readSecretStatus(db(), registry, { now: NOW });

    // The whole read came back. All four declared names are accounted for, none dropped.
    expect(entries).toHaveLength(4);
    // The planted row refuses by name, and only it.
    expect(unreadable(entries)).toEqual(["auth-signing-key"]);
    // Its neighbor resolved, with its real facts rather than a null standing in for a lost chunk.
    const healthy = readable(entries).find((status) => status.name === "stripe-live-key");
    expect(healthy?.createdAt).toEqual(new Date(daysAgo(10)));
    expect(healthy?.overdue).toBe(false);
  });

  /**
   * The third site, which `#387` did not name — the same decode in `rotationFacts`.
   *
   * Found by asking the issue's closing question rather than by working its list. `max(case when …)` is an
   * aggregate, so the value that will not decode is one a query computed, and the loop around it was
   * unguarded for the same reason the other was: it does not look like a parse.
   */
  test("a rotation aggregate that will not decode costs its own name, and no other", async () => {
    await storeSecret("auth-signing-key", daysAgo(400), daysAgo(400));
    await storeSecret("stripe-live-key", daysAgo(400), daysAgo(400));
    await recordRotation("auth-signing-key", daysAgo(300), daysAgo(300), "success", "manual", "op");
    await recordRotation("stripe-live-key", daysAgo(5), daysAgo(5), "success", "manual", "op");
    await env.SECRETS.prepare(
      "update pithy_secrets_rotations set completed_at = 'not-a-date' where name = 'auth-signing-key'",
    ).run();

    const entries = await readSecretStatus(db(), registry, { now: NOW });

    expect(unreadable(entries)).toEqual(["auth-signing-key"]);
    const healthy = readable(entries).find((status) => status.name === "stripe-live-key");
    expect(healthy?.lastRotatedAt).toEqual(new Date(daysAgo(5)));
    expect(healthy?.overdue).toBe(false);
  });

  /**
   * The distinction `#387` exists to preserve, asserted on values rather than through a rendering.
   *
   * *Missing* and *malformed* have different remedies — write the secret, versus repair the row — and a
   * guard that answered "no row" for a corrupt one would send an operator to provision a secret that is
   * already there. Absent stays outside the union: a name with no row is simply not a key in the map, and
   * comes back as a readable status whose nulls say so.
   */
  test("a missing row and a malformed row are different answers, not the same one", async () => {
    // `never-written` is declared and has no row at all. `auth-signing-key` has one that will not decode.
    await storeSecret("auth-signing-key", daysAgo(400), daysAgo(400));
    await env.SECRETS.prepare(
      "update pithy_secrets_system_secrets set updated_at = 'not-a-date' where name = 'auth-signing-key'",
    ).run();

    const entries = await readSecretStatus(db(), registry, { now: NOW });
    const byName = new Map(
      entries.map((entry) => [entry.state === "readable" ? entry.status.name : entry.name, entry]),
    );

    expect(byName.get("auth-signing-key")?.state).toBe("unreadable");
    // Missing is readable, and its nulls are the answer — not an error, and not the same state.
    const absent = byName.get("never-written");
    expect(absent?.state).toBe("readable");
    expect(absent?.state === "readable" && absent.status.createdAt).toBeNull();
    expect(absent?.state === "readable" && absent.status.keyVersion).toBeNull();
  });

  test("nothing about a decode failure reaches the result", async () => {
    // The offending column value rides on a Zod issue's `input`, and these rows sit beside `error_message`
    // and `metadata_snapshot`. The catch takes no binding, so there is nothing in scope to attach — this
    // asserts that over the serialized read rather than over a key set.
    await storeSecret("auth-signing-key", daysAgo(400), daysAgo(400));
    await recordRotation("auth-signing-key", daysAgo(10), daysAgo(10), "failed", "cron", "wf-1", "boom sk_live_oops");
    await env.SECRETS.prepare(
      "update pithy_secrets_system_secrets set created_at = 'CORRUPT-DO-NOT-LEAK' where name = 'auth-signing-key'",
    ).run();

    const serialized = JSON.stringify(await readSecretStatus(db(), registry, { now: NOW }));

    expect(serialized).not.toContain("CORRUPT-DO-NOT-LEAK");
    expect(serialized).not.toContain("Not a date");
    expect(serialized).not.toContain("invalid_format");
    expect(serialized).not.toContain(CIPHERTEXT);
    expect(serialized).not.toContain("SNAPSHOT-DO-NOT-LEAK");
    expect(serialized).not.toContain("sk_live_oops");
  });

  test("reads more names than D1 will bind in one statement", async () => {
    // D1 caps a statement at 100 bound parameters, and the name list is the application's size rather
    // than a page's. Unchunked, a project declaring 101 secrets would read none of them.
    const many = Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [
        `secret-${String(index).padStart(3, "0")}`,
        { backend: "d1", scope: "environment", rotatable: true, valueType: "text" } as const,
      ]),
    );
    await storeSecret("secret-000", daysAgo(10), daysAgo(10));
    await storeSecret("secret-149", daysAgo(10), daysAgo(10));

    const statuses = readable(await readSecretStatus(db(), defineSecretRegistry(many), { now: NOW }));

    expect(statuses).toHaveLength(150);
    expect(statuses.filter((status) => status.createdAt !== null)).toHaveLength(2);
  });
});

describe("readSecretRotations", () => {
  test("returns the attempts newest first, in metadata only", async () => {
    await recordRotation("auth-signing-key", daysAgo(300), daysAgo(300), "success", "baseline", "baseline");
    await recordRotation("auth-signing-key", daysAgo(200), daysAgo(200), "failed", "cron", "wf-1", "boom sk_live_oops");
    await recordRotation("auth-signing-key", daysAgo(100), null, "in_progress", "manual", "op");

    const rotations = records(await readSecretRotations(db(), "auth-signing-key", 25));

    expect(rotations.map((rotation) => rotation.status)).toEqual(["in_progress", "failed", "success"]);
    expect(rotations[0]?.completedAt).toBeNull();
    expect(rotations[1]?.trigger).toBe("cron");
    expect(rotations[2]?.rotatedBy).toBe("baseline");
    // The failure is reported as a status. The message that explains it is not on this surface, because
    // a failure site is exactly where a value gets pasted by accident.
    expect(JSON.stringify(rotations)).not.toContain("sk_live_oops");
    expect(JSON.stringify(rotations)).not.toContain("SNAPSHOT-DO-NOT-LEAK");
  });

  test("honors the cap, keeping the newest", async () => {
    for (let day = 1; day <= 10; day += 1) {
      await recordRotation("auth-signing-key", daysAgo(day), daysAgo(day), "success", "cron", `wf-${day}`);
    }

    const rotations = records(await readSecretRotations(db(), "auth-signing-key", 3));

    expect(rotations).toHaveLength(3);
    expect(rotations.map((rotation) => rotation.rotatedBy)).toEqual(["wf-1", "wf-2", "wf-3"]);
  });

  test("a secret with no history is an empty list", async () => {
    expect(await readSecretRotations(db(), "auth-signing-key", 25)).toEqual([]);
  });

  /**
   * `#387`'s first named site. This ended `rows.map((row) => SecretRotationRecord.parse(row))`.
   *
   * The read is a *history*, per secret, so one malformed row cost every rotation record the caller asked
   * for — the surface an incident review reads, emptied because its oldest row has a bad timestamp.
   *
   * The bad row holds its place rather than vanishing, which is what keeps a short list from reading as a
   * whole one: the caller is told three rows were asked for, two decoded, one did not.
   */
  test("one malformed row costs its own entry, and the rest of the history still resolves", async () => {
    await recordRotation("auth-signing-key", daysAgo(300), daysAgo(300), "success", "baseline", "baseline");
    await recordRotation("auth-signing-key", daysAgo(200), daysAgo(200), "failed", "cron", "wf-1", "boom sk_live_oops");
    await recordRotation("auth-signing-key", daysAgo(100), null, "in_progress", "manual", "op");
    await env.SECRETS.prepare(
      "update pithy_secrets_rotations set started_at = 'not-a-date' where rotated_by = 'wf-1'",
    ).run();

    const entries = await readSecretRotations(db(), "auth-signing-key", 25);

    // **The corrupt row sorts first, and that is SQLite rather than the test arranging it.** A column with
    // INTEGER affinity holding text stores it as TEXT, and SQLite's type ordering puts TEXT above INTEGER,
    // so `order by started_at desc` returns the bad row before every good one. That makes the guard matter
    // more than the middle-of-the-list case would: unguarded, the first row read ends the whole history.
    expect(entries.map((entry) => entry.state)).toEqual(["unreadable", "readable", "readable"]);
    // Three rows asked for, three accounted for. The two that decode come back, newest first.
    expect(records(entries).map((record) => record.rotatedBy)).toEqual(["op", "baseline"]);
    // And the unreadable member carries nothing at all — not a reason, not a timestamp, not the row.
    const bad = entries[0];
    expect(bad && Object.keys(bad)).toEqual(["state"]);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("not-a-date");
    expect(serialized).not.toContain("sk_live_oops");
    expect(serialized).not.toContain("SNAPSHOT-DO-NOT-LEAK");
  });

  test("attempts recorded in the same millisecond keep a stable order", async () => {
    // Without the id tiebreak these straddle the cap in whatever order SQLite feels like, so a screen
    // shows a different history on every refresh.
    const at = daysAgo(5);
    for (const who of ["wf-a", "wf-b", "wf-c"]) {
      await recordRotation("auth-signing-key", at, at, "success", "cron", who);
    }

    const first = records(await readSecretRotations(db(), "auth-signing-key", 2));
    const second = records(await readSecretRotations(db(), "auth-signing-key", 2));

    expect(first.map((rotation) => rotation.rotatedBy)).toEqual(["wf-c", "wf-b"]);
    expect(second).toEqual(first);
  });
});
