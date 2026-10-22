// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { EncryptionConfig } from "@pithy-sh/core/src/crypto/envelope";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { phi, pii } from "@pithy-sh/core/src/privacy/classes";
import { blindIndex, encrypted, encryptedTable } from "@pithy-sh/core/src/privacy/encrypted";
import { deriveEncryptedColumns, type EncryptedColumnStamp } from "@pithy-sh/core/src/privacy/encryptedColumns";
import { sealed } from "@pithy-sh/core/src/privacy/sealed";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { FIELD_KEY_ROTATION_NAME } from "../data/secretRotations";
import { secretsTables } from "../data/tables";
import type { ConfigReader } from "../manager/configReader";
import { secrets_0001_init } from "../migrations/0001_init";
import { RotationTracker } from "../store/rotationTracker";
import { StubConfigStore } from "../test-utils/stubConfigWriter";
import type { StepRunner } from "./atRestKeyRotation";
import { type FieldKeyRotationDeps, MAX_LIVE_FIELD_KEY_VERSIONS, runFieldKeyCommand } from "./fieldKeyRotation";

/**
 * **The field-key rotation, against a real D1** (#390): add a version, re-seal and re-index only what is leaving,
 * retire on a clean guard, keep everything on a dirty one, fail a version still live at the next rotation, and
 * refuse a fifth.
 */

function keyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function keySet(versions: number[], keys: Record<string, string> = {}): EncryptionConfig {
  return {
    currentVersion: String(Math.max(...versions)),
    versions: Object.fromEntries(versions.map((version) => [String(version), keys[String(version)] ?? keyB64()])),
    lastRotatedAt: "2026-09-01T00:00:00.000Z",
  };
}

const syncStep: StepRunner = { do: (_name, fn) => fn(), sleep: async () => undefined };

const Patient = encryptedTable(
  z
    .object({
      id: z.string().describe("id"),
      diagnosis: encrypted(phi(z.string().describe("The condition."))),
      email: encrypted(pii(z.string().describe("Where we write.")), { index: "email" }),
      emailIndex: blindIndex("email"),
    })
    .describe("A patient."),
  { name: "patient", key: "id" },
);
const tables = { patients: Patient };
const app = createDatabase(env.APP_DB, tables);
const stamp = (): EncryptedColumnStamp =>
  deriveEncryptedColumns([
    defineCapability({ name: "app", requiredBindings: [], databases: { app: { binding: "APP_DB", tables } } }),
  ]);

async function insert(config: EncryptionConfig, id: string): Promise<void> {
  const record = await sealed(Patient, { keys: config }).seal({
    id,
    diagnosis: `condition ${id}`,
    email: `${id}@example.com`,
  } as never);
  await app.insertInto("patients").values(record).execute();
}

const events: AuditEventInput[] = [];

function deps(
  config: EncryptionConfig,
  store: StubConfigStore,
  over: Partial<FieldKeyRotationDeps> = {},
): FieldKeyRotationDeps {
  return {
    config,
    stamp: stamp(),
    database: (binding) => (binding === "APP_DB" ? env.APP_DB : undefined),
    writer: store.writer,
    reader: store.reader,
    tracker: RotationTracker.fromD1(env.SECRETS),
    emit: async (event) => {
      events.push(event);
    },
    ...over,
  };
}

async function lastLedgerRow() {
  return env.SECRETS.prepare(
    "select status, error_message from pithy_secrets_rotations order by id desc limit 1",
  ).first<{
    status: string;
    error_message: string | null;
  }>();
}

const fast = { readBackAttempts: 3, readBackDelayMs: 0, now: new Date("2026-10-01T03:00:00.000Z") };

beforeEach(async () => {
  events.length = 0;
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
  await env.APP_DB.prepare("drop table if exists patients").run();
  await env.APP_DB.prepare(
    "create table patients (id text primary key, diagnosis text not null, email text not null, email_index text not null)",
  ).run();
});

describe("rotate", () => {
  test("adds a version that becomes current, staged then promoted, and every write after it seals under it", async () => {
    const config = keySet([1, 2]);
    const store = new StubConfigStore({ bound: config });
    const report = await runFieldKeyCommand(deps(config, store), syncStep, { mode: "rotate" }, fast);
    // Staged under the old pointer, promoted, then the retirement of version 1, which nothing is sealed under.
    expect(store.writes.map((write) => write.config.currentVersion)).toEqual(["2", "3", "3"]);
    expect(Object.keys(store.writes[0]?.config.versions ?? {}).sort()).toEqual(["1", "2", "3"]);
    expect(report.liveVersions).toEqual([3, 2]);
    const record = await sealed(Patient, { keys: store.lastWritten }).seal({
      id: "p9",
      diagnosis: "x",
      email: "e",
    } as never);
    expect(JSON.parse(record.diagnosis as string).keyVersion).toBe(3);
  });

  test("re-seals and re-indexes only the rows under the version leaving, then retires it on a clean guard", async () => {
    const config = keySet([1, 2]);
    await insert(config, "p1");
    // Sealed under version 1, which is the one leaving once version 3 is added.
    const old = keySet([1], { "1": config.versions["1"] as string });
    await insert(old, "p0");
    const before = await app.selectFrom("patients").selectAll().where("id", "=", "p1").executeTakeFirstOrThrow();
    const store = new StubConfigStore({ bound: config });
    const report = await runFieldKeyCommand(deps(config, store), syncStep, { mode: "rotate" }, fast);
    expect(report.retired).toEqual([1]);
    expect(report.liveVersions).toEqual([3, 2]);
    expect(report.verdict).toEqual({ blocked: false, reasons: [], liveVersions: 2 });
    // The row on version 2 was not touched.
    expect(await app.selectFrom("patients").selectAll().where("id", "=", "p1").executeTakeFirstOrThrow()).toEqual(
      before,
    );
    // The row on version 1 now opens under the retired set, and its index matches under version 3.
    const final = store.lastWritten as EncryptionConfig;
    const rows = await app.selectFrom("patients").selectAll().orderBy("id").execute();
    const opened = await Promise.all(rows.map((row) => sealed(Patient, { keys: final }).open(row)));
    expect(opened.map((row) => row.diagnosis)).toEqual(["condition p0", "condition p1"]);
    expect(rows[0]?.emailIndex).toMatch(/^3:/);
    expect(events.map((event) => event.action)).toEqual(["secrets/field_key_retired"]);
    expect((await lastLedgerRow())?.status).toBe("success");
  });

  test("on a dirty guard nothing is retired, and rotation and the backfill continue", async () => {
    const config = keySet([1, 2]);
    const store = new StubConfigStore({ bound: config });
    const report = await runFieldKeyCommand(
      deps(config, store, { stamp: { ...stamp(), unread: ["apps/billing"] } }),
      syncStep,
      { mode: "rotate" },
      fast,
    );
    expect(report.retired).toEqual([]);
    expect(report.liveVersions).toEqual([3, 2, 1]);
    expect(report.verdict).toEqual({ blocked: true, reasons: ["incomplete-coverage"], liveVersions: 3 });
    expect(events).toMatchObject([{ action: "secrets/field_key_retirement_blocked", severity: "warning" }]);
    // Not overdue yet: the version became due this period, so the pass is a success.
    expect((await lastLedgerRow())?.status).toBe("success");
  });

  test("an unrotatable field blocks retirement", async () => {
    const config = keySet([1, 2]);
    const store = new StubConfigStore({ bound: config });
    const report = await runFieldKeyCommand(
      deps(config, store, { stamp: { ...stamp(), unrotatable: ["app:cache.tokens:value.token"] } }),
      syncStep,
      { mode: "rotate" },
      fast,
    );
    expect(report.verdict.reasons).toEqual(["unrotatable"]);
    expect(report.retired).toEqual([]);
  });

  test("a version still live when the next rotation is due raises an audit event naming the blocker, and fails", async () => {
    const config = keySet([1, 2, 3]);
    const old = keySet([1], { "1": config.versions["1"] as string });
    await insert(old, "p0");
    const store = new StubConfigStore({ bound: config });
    const stuck = deps(config, store, { database: () => undefined });
    await runFieldKeyCommand(stuck, syncStep, { mode: "rotate" }, fast);
    expect(events).toMatchObject([
      {
        action: "secrets/field_key_retirement_blocked",
        severity: "critical",
        metadata: { reasons: "incomplete-coverage", overdue: true },
      },
    ]);
    expect(await lastLedgerRow()).toEqual({
      status: "failed",
      error_message: "a field-key version was still live when the next rotation came due",
    });
  });

  test(`refuses to add a version while ${MAX_LIVE_FIELD_KEY_VERSIONS} are live, naming the blocker`, async () => {
    const config = keySet([1, 2, 3, 4]);
    await insert(keySet([1], { "1": config.versions["1"] as string }), "p0");
    const store = new StubConfigStore({ bound: config });
    const report = await runFieldKeyCommand(
      deps(config, store, { stamp: { ...stamp(), unread: ["apps/billing"] } }),
      syncStep,
      { mode: "rotate" },
      fast,
    );
    expect(report.outcome).toBe("refused");
    expect(store.writes).toEqual([]);
    expect(report.liveVersions).toEqual([4, 3, 2, 1]);
    expect(report.verdict.reasons).toEqual(["incomplete-coverage"]);
    expect(events).toMatchObject([
      {
        action: "secrets/field_key_retirement_blocked",
        severity: "critical",
        metadata: { reasons: "incomplete-coverage" },
      },
    ]);
    expect((await lastLedgerRow())?.error_message).toBe("the field-key rotation was refused: four versions are live");
  });

  test("at the ceiling it still re-seals and retires on a clean guard, so the refusal clears itself", async () => {
    const config = keySet([1, 2, 3, 4]);
    await insert(keySet([1], { "1": config.versions["1"] as string }), "p0");
    await insert(keySet([2], { "2": config.versions["2"] as string }), "p1");
    const store = new StubConfigStore({ bound: config });
    const report = await runFieldKeyCommand(deps(config, store), syncStep, { mode: "rotate" }, fast);
    // No version added: the one write is the retirement of the two the backfill cleared.
    expect(store.writes.map((write) => Object.keys(write.config.versions).sort())).toEqual([["3", "4"]]);
    expect(report.outcome).toBe("backfilled");
    expect(report.retired).toEqual([2, 1]);
    expect(report.liveVersions).toEqual([4, 3]);
    const rows = await app.selectFrom("patients").selectAll().orderBy("id").execute();
    expect(rows.map((row) => JSON.parse(row.diagnosis as string).keyVersion)).toEqual([4, 4]);
    expect((await lastLedgerRow())?.status).toBe("success");
    // And the next rotation adds a version again.
    events.length = 0;
    const next = await runFieldKeyCommand(
      deps(store.boundConfig, store),
      syncStep,
      { mode: "rotate" },
      { ...fast, now: new Date("2026-10-02T03:00:00.000Z") },
    );
    expect(next.outcome).toBe("rotated");
    expect(next.liveVersions).toEqual([5, 4]);
  });

  test("a write the binding never shows aborts before anything is re-sealed", async () => {
    const config = keySet([1, 2]);
    await insert(keySet([1], { "1": config.versions["1"] as string }), "p0");
    const store = new StubConfigStore({ bound: config, propagate: 100 });
    await expect(runFieldKeyCommand(deps(config, store), syncStep, { mode: "rotate" }, fast)).rejects.toThrow(
      /did not come back through the binding/,
    );
    const row = await app.selectFrom("patients").select("diagnosis").executeTakeFirstOrThrow();
    expect(JSON.parse(row.diagnosis as string).keyVersion).toBe(1);
    expect((await lastLedgerRow())?.error_message).toBe(
      "the field-key rotation could not confirm its write through the binding",
    );
  });
});

describe("backfill, guard and retire", () => {
  test("the nightly backfill clears what is left and retires on a clean guard", async () => {
    const config = keySet([1, 2, 3]);
    await insert(keySet([1], { "1": config.versions["1"] as string }), "p0");
    const store = new StubConfigStore({ bound: config });
    const report = await runFieldKeyCommand(
      deps(config, store),
      syncStep,
      { mode: "backfill" },
      { ...fast, batchSize: 1 },
    );
    expect(report.retired).toEqual([1]);
    expect(Object.keys(store.lastWritten?.versions ?? {}).sort()).toEqual(["2", "3"]);
  });

  test("guard reads the stale counts per column and writes nothing", async () => {
    const config = keySet([1, 2, 3]);
    await insert(keySet([1], { "1": config.versions["1"] as string }), "p0");
    const store = new StubConfigStore({ bound: config });
    const report = await runFieldKeyCommand(deps(config, store), syncStep, { mode: "guard" }, fast);
    expect(report.columns).toEqual([
      { table: "patients", column: "diagnosis", path: "diagnosis", stale: 1 },
      { table: "patients", column: "email", path: "email", stale: 1 },
    ]);
    expect(report.verdict).toEqual({ blocked: true, reasons: ["stale"], liveVersions: 3 });
    expect(store.writes).toEqual([]);
  });

  test("retire past the guard drops one version, audits it critical, and refuses the current one", async () => {
    const config = keySet([1, 2, 3]);
    const store = new StubConfigStore({ bound: config });
    await expect(
      runFieldKeyCommand(deps(config, store), syncStep, { mode: "retire", version: 3, pastGuard: true }, fast),
    ).rejects.toThrow(/current version/);
    const report = await runFieldKeyCommand(
      deps(config, store),
      syncStep,
      { mode: "retire", version: 1, pastGuard: true },
      fast,
    );
    expect(report.retired).toEqual([1]);
    expect(Object.keys(store.lastWritten?.versions ?? {}).sort()).toEqual(["2", "3"]);
    expect(events).toMatchObject([
      { action: "secrets/field_key_retired", severity: "critical", metadata: { pastGuard: true } },
    ]);
  });
});

/**
 * **A resumed instance decides from what it journalled, never from the binding as it reads now.** A Workflow body
 * re-runs from the top on every resume, and the shell re-resolves `PITHY_FIELD_KEYS` each time, so by the resume
 * after a read-back sleep the binding already shows the staged version.
 */
describe("a resumed instance", () => {
  /** The interruption a resumed Workflow is the recovery from. Not a `PithyError`: this is the platform. */
  class Interrupted extends Error {}

  /** The journal: a completed step returns what it returned first, and a named step kills the instance once. */
  function journalledStep(journal: Map<string, unknown>, dies: string[] = []): StepRunner {
    const armed = new Set(dies);
    return {
      async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (journal.has(name)) return journal.get(name) as T;
        if (armed.has(name)) {
          armed.delete(name);
          throw new Interrupted(`the pass died before ${name}`);
        }
        const result = await fn();
        journal.set(name, result);
        return result;
      },
      sleep: async () => undefined,
    };
  }

  test("is not overdue on a normal first rotation because the binding now shows the staged version", async () => {
    const config = keySet([1, 2]);
    const store = new StubConfigStore({ bound: config });
    const journal = new Map<string, unknown>();
    const dirty = { stamp: { ...stamp(), unread: ["apps/billing"] } };
    await expect(
      runFieldKeyCommand(
        deps(config, store, dirty),
        journalledStep(journal, ["write-promoted", "mark-failure"]),
        { mode: "rotate" },
        fast,
      ),
    ).rejects.toBeInstanceOf(Interrupted);
    // The resume: the shell resolves the binding again, which now holds versions 1, 2 and 3.
    expect(Object.keys(store.boundConfig.versions).sort()).toEqual(["1", "2", "3"]);
    const report = await runFieldKeyCommand(
      deps(store.boundConfig, store, dirty),
      journalledStep(journal),
      { mode: "rotate" },
      fast,
    );
    expect(report.liveVersions).toEqual([3, 2, 1]);
    expect(events).toMatchObject([{ action: "secrets/field_key_retirement_blocked", severity: "warning" }]);
    expect((await lastLedgerRow())?.status).toBe("success");
  });

  test(`is not refused at the ceiling by the version it staged itself`, async () => {
    const config = keySet([1, 2, 3]);
    const store = new StubConfigStore({ bound: config });
    const journal = new Map<string, unknown>();
    await expect(
      runFieldKeyCommand(
        deps(config, store),
        journalledStep(journal, ["write-promoted", "mark-failure"]),
        { mode: "rotate" },
        fast,
      ),
    ).rejects.toBeInstanceOf(Interrupted);
    expect(Object.keys(store.boundConfig.versions)).toHaveLength(MAX_LIVE_FIELD_KEY_VERSIONS);
    const report = await runFieldKeyCommand(
      deps(store.boundConfig, store),
      journalledStep(journal),
      { mode: "rotate" },
      fast,
    );
    expect(report.outcome).toBe("rotated");
    expect(report.liveVersions).toEqual([4, 3]);
    expect((await lastLedgerRow())?.status).toBe("success");
  });

  test("a retire resumed after its write finishes rather than refusing the version it already retired", async () => {
    const config = keySet([1, 2, 3]);
    const store = new StubConfigStore({ bound: config });
    const journal = new Map<string, unknown>();
    const command = { mode: "retire", version: 1, pastGuard: true } as const;
    await expect(
      runFieldKeyCommand(
        deps(config, store),
        journalledStep(journal, ["retire-close", "retire-failure"]),
        command,
        fast,
      ),
    ).rejects.toBeInstanceOf(Interrupted);
    const report = await runFieldKeyCommand(deps(store.boundConfig, store), journalledStep(journal), command, fast);
    expect(report.retired).toEqual([1]);
    expect(store.writes).toHaveLength(1);
    expect(events.filter((event) => event.action === "secrets/field_key_retired")).toHaveLength(1);
    expect((await lastLedgerRow())?.status).toBe("success");
  });
});

/**
 * **Every write of the key set holds the ledger's single-flight lock, and writes over the set it read.** The entry
 * takes a full-value replace, so a retire that read `{1,2,3}` and wrote `{2,3}` after a rotation promoted 4 would
 * delete version 4 under every row sealed with it — the lost update `#647` closed for the master key.
 */
describe("one writer at a time", () => {
  const tracker = () => RotationTracker.fromD1(env.SECRETS);

  test("a retire while a rotation holds the ledger is refused and writes nothing", async () => {
    const config = keySet([1, 2, 3]);
    const store = new StubConfigStore({ bound: config });
    await tracker().claimRotation(FIELD_KEY_ROTATION_NAME, "cron", "field-keys-rotate");
    await expect(
      runFieldKeyCommand(deps(config, store), syncStep, { mode: "retire", version: 1, pastGuard: true }, fast),
    ).rejects.toThrow(/already running/);
    expect(store.writes).toEqual([]);
  });

  test("a backfill while a rotation holds the ledger re-seals and retires nothing", async () => {
    const config = keySet([1, 2, 3]);
    const store = new StubConfigStore({ bound: config });
    await tracker().claimRotation(FIELD_KEY_ROTATION_NAME, "cron", "field-keys-rotate");
    const report = await runFieldKeyCommand(deps(config, store), syncStep, { mode: "backfill" }, fast);
    expect(report.retired).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  test("a rotation while a retire holds the ledger is refused", async () => {
    const config = keySet([1, 2, 3]);
    const store = new StubConfigStore({ bound: config });
    await tracker().claimRotation(FIELD_KEY_ROTATION_NAME, "manual", "field-keys-retire");
    await expect(runFieldKeyCommand(deps(config, store), syncStep, { mode: "rotate" }, fast)).rejects.toThrow(
      /already running/,
    );
    expect(store.writes).toEqual([]);
  });

  test("a retire whose key set changed before its write refuses, writes nothing and closes its row", async () => {
    const config = keySet([1, 2, 3]);
    const store = new StubConfigStore({ bound: config });
    // The binding moves between the read the retire decided from and its write: a rotation promoted version 4.
    const moved: EncryptionConfig = {
      ...config,
      currentVersion: "4",
      versions: { ...config.versions, "4": keyB64() },
    };
    let reads = 0;
    const reader: ConfigReader = {
      read: async () => {
        reads += 1;
        return reads === 1 ? config : moved;
      },
    };
    await expect(
      runFieldKeyCommand(
        deps(config, store, { reader }),
        syncStep,
        { mode: "retire", version: 1, pastGuard: true },
        fast,
      ),
    ).rejects.toThrow(/changed/);
    expect(store.writes).toEqual([]);
    expect((await lastLedgerRow())?.status).toBe("failed");
  });

  test("a backfill whose key set changed before its retirement refuses and writes nothing", async () => {
    const config = keySet([1, 2, 3]);
    const store = new StubConfigStore({ bound: config });
    const moved: EncryptionConfig = { ...config, versions: { ...config.versions, "4": keyB64() } };
    let reads = 0;
    const reader: ConfigReader = {
      read: async () => {
        reads += 1;
        return reads === 1 ? config : moved;
      },
    };
    await expect(
      runFieldKeyCommand(deps(config, store, { reader }), syncStep, { mode: "backfill" }, fast),
    ).rejects.toThrow(/changed/);
    expect(store.writes).toEqual([]);
    expect((await lastLedgerRow())?.status).toBe("failed");
  });
});
