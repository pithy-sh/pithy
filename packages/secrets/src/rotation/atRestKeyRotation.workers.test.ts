// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { beforeEach, describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import { initialVersionedValue } from "../crypto/versionedValue";
import { secretsTables } from "../data/tables";
import { secretsWorkflowRetry } from "../manager/retryPolicy";
import { secrets_0001_init } from "../migrations/0001_init";
import { RotationTracker } from "../store/rotationTracker";
import { SystemSecretsStore } from "../store/systemSecretsStore";
import { StubConfigStore } from "../test-utils/stubConfigWriter";
import {
  type AtRestRotationDeps,
  type AtRestRotationOptions,
  atRestInstanceId,
  runAtRestKeyRotation,
  type StepRunner,
} from "./atRestKeyRotation";
import { MAX_KEY_SET_SIZE } from "./keyRotation";

function keyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const v1: EncryptionConfig = {
  currentVersion: "1",
  versions: { "1": keyB64() },
  lastRotatedAt: "2026-01-01T00:00:00.000Z",
};

/** A synchronous step runner — runs each callback immediately, and waits for nothing. */
const syncStep: StepRunner = { do: (_name, fn) => fn(), sleep: async () => undefined };

/**
 * A step runner that runs `before(name)` ahead of each step — the only way a synchronous drive can change
 * the store's behavior *between* two steps, which is what the promoted-write cases need.
 */
function hookedStep(before: (name: string) => void): StepRunner {
  return {
    do: (name, fn) => {
      before(name);
      return fn();
    },
    sleep: async () => undefined,
  };
}

const db = () => createDatabase(env.SECRETS, secretsTables);

function depsOver(store: StubConfigStore, config: EncryptionConfig = v1): AtRestRotationDeps {
  return {
    db: db(),
    config,
    configWriter: store.writer,
    configReader: store.reader,
    tracker: RotationTracker.fromD1(env.SECRETS),
  };
}

/** Five attempts and no waiting, so a test spends milliseconds proving what production spends a minute on. */
const fastReadBack: AtRestRotationOptions = { readBackAttempts: 5, readBackDelayMs: 0 };

async function latestRotation(): Promise<{ status: string; name: string; error_message: string | null }> {
  const row = await env.SECRETS.prepare(
    "select status, name, error_message from pithy_secrets_rotations order by id desc limit 1",
  ).first<{ status: string; name: string; error_message: string | null }>();
  if (!row) throw new Error("no rotation row");
  return row;
}

async function keyVersionOf(name: string): Promise<number | undefined> {
  const row = await env.SECRETS.prepare("select key_version as v from pithy_secrets_system_secrets where name = ?")
    .bind(name)
    .first<{ v: number }>();
  return row?.v;
}

/**
 * A row that will never re-encrypt: a well-formed envelope over bytes no key opens.
 *
 * It is planted rather than produced, because the state it stands for — a ciphertext corrupted in
 * storage, a row written under a key that has since been lost — has no happy path that reaches it. This is
 * the row that holds a key version forever: `reencryptBatch` counts it `failed` and leaves it where it is,
 * and the prune gate then refuses to retire the version it sits on, for good.
 */
async function plantUndecryptable(name: string, keyVersion: number): Promise<void> {
  const now = Date.now();
  await env.SECRETS.prepare(
    "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values (?, ?, ?, ?, 'text', ?, ?)",
  )
    .bind(name, "Y29ycnVwdGVkLWNpcGhlcnRleHQ=", "AAAAAAAAAAAAAAAA", keyVersion, now, now)
    .run();
}

/** A key set of `size` versions, pointed at the highest — what a store looks like after retirement stalls. */
function keySetOf(size: number): EncryptionConfig {
  const versions: Record<string, string> = {};
  for (let version = 1; version <= size; version++) versions[String(version)] = keyB64();
  return { currentVersion: String(size), versions, lastRotatedAt: v1.lastRotatedAt };
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(db());
});

/**
 * **The eight-step sequence, and the two read-backs that make it a sequence rather than a hope (`#647`).**
 *
 * The pass used to persist `{ currentVersion: N+1 }` before re-encrypting a row, never read it back, and
 * prune N in the same breath. A write that reached an entry the binding does not read answered 200 — and
 * every row was then sealed under a key nothing bound. These cases drive the order, both gates, and what
 * each abort costs the store.
 */
describe("runAtRestKeyRotation — the staged sequence", () => {
  test("publishes the key under the old pointer first, and moves the pointer only after re-encrypting", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const store = new StubConfigStore({ bound: v1 });

    const result = await runAtRestKeyRotation(depsOver(store), syncStep, {
      ...fastReadBack,
      now: new Date("2026-02-01T00:00:00.000Z"),
    });

    // Two writes, in this order and no other: the key, then the pointer. A pass that wrote the promoted
    // envelope first — which is what `#647` was — puts "2" in the first slot and fails here.
    expect(store.writes.map((write) => write.config.currentVersion)).toEqual(["1", "2"]);
    expect(Object.keys(store.writes[0]?.config.versions ?? {}).sort()).toEqual(["1", "2"]);
    // The staged write leaves the cadence clock alone, so a pass that aborts before promoting does not
    // report itself rotated and the cron asks again.
    expect(store.writes[0]?.config.lastRotatedAt).toBe(v1.lastRotatedAt);
    expect(store.writes[1]?.config.lastRotatedAt).toBe("2026-02-01T00:00:00.000Z");
    // Nothing is pruned in the pass that rotated: the superseded key survives a generation.
    expect(result).toMatchObject({ rotated: 1, failed: 0, newCurrentVersion: 2, pruned: false });
    expect(await keyVersionOf("a")).toBe(2);
    expect(await new SystemSecretsStore(db(), store.boundConfig).getValue("a")).toEqual({
      currentVersion: "1",
      versions: { "1": "va" },
    });
    expect(await latestRotation()).toMatchObject({ status: "success", name: "__at_rest_key_rotation__" });
  });

  test("an empty store rotates the key with nothing to re-encrypt", async () => {
    const store = new StubConfigStore({ bound: v1 });
    const result = await runAtRestKeyRotation(depsOver(store), syncStep, fastReadBack);
    expect(result).toMatchObject({ rotated: 0, failed: 0, pruned: false });
    expect((await latestRotation()).status).toBe("success");
  });

  /**
   * **Absent, then present.** A store that lags is the ordinary reason a read-back does not show a write
   * on the first ask, and the whole point of spending sleeps between separate reads is to ride it out.
   * Fails if the read-back collapses to a single attempt.
   */
  test("a write the binding shows late still completes the rotation", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const store = new StubConfigStore({ bound: v1, propagate: 2 });

    const result = await runAtRestKeyRotation(depsOver(store), syncStep, fastReadBack);

    expect(result).toMatchObject({ rotated: 1, newCurrentVersion: 2 });
    // It genuinely had to ask more than once, on both gates — otherwise this passes for the wrong reason.
    expect(store.reads).toBeGreaterThanOrEqual(6);
    expect(await keyVersionOf("a")).toBe(2);
  });

  /**
   * **Absent throughout: the failure this issue exists for.** The write reached an entry the binding does
   * not read. Fails the moment the step-4 gate is removed — the pass would go on to re-encrypt every row
   * under a key nothing bound and report success.
   */
  test("a write the binding never shows aborts before a single row is re-encrypted", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const store = new StubConfigStore({ bound: v1, propagate: Number.POSITIVE_INFINITY });

    await expect(runAtRestKeyRotation(depsOver(store), syncStep, fastReadBack)).rejects.toThrow(
      "did not come back through the binding",
    );

    // One write — the staged one — and nothing after it.
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.config.currentVersion).toBe("1");
    // The store is exactly as it was: the row is on key 1, and key 1 is what the binding serves.
    expect(await keyVersionOf("a")).toBe(1);
    expect(store.boundConfig).toEqual(v1);
    expect(await new SystemSecretsStore(db(), store.boundConfig).getValue("a")).toEqual({
      currentVersion: "1",
      versions: { "1": "va" },
    });
    // And the ledger says which failure it was, because this one is the only at-rest failure with a
    // cadence consequence.
    expect(await latestRotation()).toMatchObject({
      status: "failed",
      error_message: "the at-rest key rotation could not confirm its write through the binding",
    });
  });

  /**
   * **The REST stamp may refuse a pass and may never satisfy one.** Cloudflare took the edit and returns
   * the comment this pass wrote — a perfect inspection — over a value the binding never serves. Fails if
   * the stamp check is ever allowed to stand in for the binding read-back, which is the one refactor this
   * whole design is one step away from.
   */
  test("a perfect REST stamp does not advance a pass the binding will not confirm", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const store = new StubConfigStore({ bound: v1, propagate: Number.POSITIVE_INFINITY });

    await expect(runAtRestKeyRotation(depsOver(store), syncStep, fastReadBack)).rejects.toThrow(
      "did not come back through the binding",
    );

    // REST is entirely happy: the entry carries this pass's own stamp, naming the staged key set.
    const facts = await store.writer.inspect();
    expect(facts?.stamp).toMatchObject({ currentVersion: "1", versions: ["1", "2"] });
    expect(await keyVersionOf("a")).toBe(1);
  });

  /**
   * The second gate. By the time it fires the rows are already sealed under a key the binding *has*
   * confirmed, so this abort leaves a store that reads — a failed rotation, not an outage. Fails if the
   * step-7 confirmation is dropped: the pass would report success over a pointer that never moved.
   */
  test("a pointer that does not come back aborts, and every row still opens", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const store = new StubConfigStore({ bound: v1 });
    // The staged write propagates; the promoted one does not.
    const step = hookedStep((name) => {
      if (name === "write-promoted-config") store.propagate = Number.POSITIVE_INFINITY;
    });

    await expect(runAtRestKeyRotation(depsOver(store), step, fastReadBack)).rejects.toThrow(
      "still names the previous version",
    );

    expect(store.writes.map((write) => write.config.currentVersion)).toEqual(["1", "2"]);
    // Rows moved to the new key, and the binding holds that key — so nothing is lost, and new writes keep
    // sealing under the old pointer until somebody looks.
    expect(await keyVersionOf("a")).toBe(2);
    expect(store.boundConfig.currentVersion).toBe("1");
    expect(await new SystemSecretsStore(db(), store.boundConfig).getValue("a")).toEqual({
      currentVersion: "1",
      versions: { "1": "va" },
    });
  });

  /**
   * **D11.** An abort raised from the driver body is never classified, so the engine is free to re-drive
   * the instance — one fresh key and one more orphan write per attempt, which is the loop the budget
   * exists to remove. Fails if either refusal is moved outside its `step.do`: the rejection is then a bare
   * `SecretCryptoError` rather than the platform's terminal class.
   */
  test("an abort is terminal, not another pass", async () => {
    class FakeTerminal extends Error {}
    const store = new StubConfigStore({ bound: v1, propagate: Number.POSITIVE_INFINITY });
    const classified = classifiedSteps(syncStep, secretsWorkflowRetry, FakeTerminal);

    await expect(runAtRestKeyRotation(depsOver(store), classified, fastReadBack)).rejects.toBeInstanceOf(FakeTerminal);
  });

  /** A budget that never asks confirms nothing and would abort a healthy pass without looking. */
  test("a read-back budget of zero is refused rather than clamped", async () => {
    const store = new StubConfigStore({ bound: v1 });
    const thrown: unknown = await runAtRestKeyRotation(depsOver(store), syncStep, {
      readBackAttempts: 0,
      readBackDelayMs: 0,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(PithyError);
    expect((thrown as PithyError).payload.detail).toContain("readBackAttempts resolved to 0");
    // Refused before anything was written, and before a rotation row was even opened.
    expect(store.writes).toHaveLength(0);
    await expect(latestRotation()).rejects.toThrow("no rotation row");
  });

  test("a write-back failure marks the rotation failed and rethrows", async () => {
    const store = new StubConfigStore({ bound: v1, writeError: new Error("cf api down") });
    await expect(runAtRestKeyRotation(depsOver(store), syncStep, fastReadBack)).rejects.toThrow("cf api down");
    expect((await latestRotation()).status).toBe("failed");
  });

  /**
   * `#386`, from the site that violated it.
   *
   * This catch is reached from decryption, envelope decoding and config parsing, and it used to write
   * `cause.message` into `error_message`. So the exception is planted to look like what those paths
   * actually throw: a sentence carrying key material. The row must hold the code's fixed text and no part
   * of it — asserted over the whole row, so a future column that captured the same text fails here too.
   */
  test("a failure writes the code's fixed sentence, and nothing the exception said", async () => {
    const PLANTED = "decrypt failed: key sk_live_PLANTED_KEY_MATERIAL, iv AAAAAAAAAAAAAAAA";
    const store = new StubConfigStore({ bound: v1, writeError: new Error(PLANTED) });

    await expect(runAtRestKeyRotation(depsOver(store), syncStep, fastReadBack)).rejects.toThrow(PLANTED);

    const row = await env.SECRETS.prepare(
      "select status, error_message, metadata_snapshot from pithy_secrets_rotations order by id desc limit 1",
    ).first<{ status: string; error_message: string | null; metadata_snapshot: string | null }>();
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toBe("the at-rest key rotation did not finish");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("sk_live_PLANTED_KEY_MATERIAL");
    expect(serialized).not.toContain("AAAAAAAAAAAAAAAA");
    expect(serialized).not.toContain("decrypt failed");
  });
});

/**
 * **The prune is deferred a full generation, and its floor is the pointer the pass superseded (D10).**
 *
 * The version a pass just superseded is exactly the one a row that failed to re-encrypt is still sitting
 * on, and the pass that created the successor is the worst moment to find out.
 */
describe("runAtRestKeyRotation — the deferred prune", () => {
  test("the pass that supersedes a key keeps it; the next pass retires it", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const store = new StubConfigStore({ bound: v1 });

    const first = await runAtRestKeyRotation(depsOver(store), syncStep, fastReadBack);
    expect(first.pruned).toBe(false);
    expect(Object.keys(store.boundConfig.versions).sort()).toEqual(["1", "2"]);

    // The prune write is deliberately not read back — it only removes keys — so it is the last *write*
    // rather than the bound value that carries it.
    const second = await runAtRestKeyRotation(depsOver(store, store.boundConfig), syncStep, fastReadBack);
    expect(second.pruned).toBe(true);
    expect(Object.keys(store.lastWritten?.versions ?? {}).sort()).toEqual(["2", "3"]);
    const pruned = store.lastWritten as EncryptionConfig;
    expect(await new SystemSecretsStore(db(), pruned).getValue("a")).toEqual({
      currentVersion: "1",
      versions: { "1": "va" },
    });
  });

  /**
   * **The abandoned-stage state, which is the state this whole sequence produces on its unhappy path.**
   * A pass staged key 2 and aborted, so the pointer is 1 and the key set holds {1, 2} with every row on
   * key 1. Fails if the prune floor is inferred from the key set: "the highest version below the pointer"
   * calls 2 the predecessor and retires key 1 in the very pass that superseded it — with the rows'
   * survival resting on a point-in-time count rather than on a generation of deferral.
   */
  test("a key abandoned by an earlier stage does not age the generation still in use", async () => {
    const abandoned: EncryptionConfig = {
      currentVersion: "1",
      versions: { "1": v1.versions["1"] ?? "", "2": keyB64() },
      lastRotatedAt: v1.lastRotatedAt,
    };
    await new SystemSecretsStore(db(), abandoned).put("a", initialVersionedValue("va"));
    const store = new StubConfigStore({ bound: abandoned });

    const result = await runAtRestKeyRotation(depsOver(store, abandoned), syncStep, fastReadBack);

    expect(result).toMatchObject({ newCurrentVersion: 3, pruned: false });
    expect(Object.keys(store.boundConfig.versions).sort()).toEqual(["1", "2", "3"]);
  });
});

/**
 * **Single-flight (D13).** Two overlapping passes each confirm their own read-backs, and the config write
 * is a full-value replace with no conditional write available — so the slower pass's promotion deletes the
 * key every row is by then sealed under, and its own read-back confirms the clobber.
 */
describe("runAtRestKeyRotation — one pass at a time", () => {
  /** The interruption a resumed Workflow is the recovery from. Not a `PithyError`: this is the platform. */
  class Interrupted extends Error {}

  /**
   * The Workflow journal, structurally: a completed step returns what it returned the first time, a step
   * never reached runs, and a named step may kill the instance once. `dies` lists the steps that kill it —
   * `mark-failure` included where the point is that an evicted instance never closes its row.
   */
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

  test("a second pass declines while one is live, so the loser cannot delete the key every row holds", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const store = new StubConfigStore({ bound: v1 });
    const journal = new Map<string, unknown>();

    // Pass A gets as far as re-encrypting and is evicted before it can publish the pointer — and before
    // it can close its own rotation row, which is what an eviction looks like.
    await expect(
      runAtRestKeyRotation(depsOver(store), journalledStep(journal, ["write-promoted-config", "mark-failure"]), {
        ...fastReadBack,
        now: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(Interrupted);
    expect(await keyVersionOf("a")).toBe(2);

    // Pass B is triggered while A's row is still open. It must not start.
    await expect(runAtRestKeyRotation(depsOver(store, store.boundConfig), syncStep, fastReadBack)).rejects.toThrow(
      "already running",
    );
    expect(store.writes).toHaveLength(1);

    // A resumes and finishes. Without the decline above, B would have promoted to key 3 and re-encrypted
    // every row onto it — and this write of A's, `{ currentVersion: "2", versions: { 1, 2 } }`, would
    // delete key 3 underneath them. The store would be unreadable and the pass would report success.
    await runAtRestKeyRotation(depsOver(store), journalledStep(journal), {
      ...fastReadBack,
      now: new Date("2026-02-01T00:00:00.000Z"),
    });

    expect(await new SystemSecretsStore(db(), store.boundConfig).getValue("a")).toEqual({
      currentVersion: "1",
      versions: { "1": "va" },
    });
    expect((await latestRotation()).status).toBe("success");
  });

  /**
   * **The overlap the wall clock let through, and the one this issue exists to prevent.**
   *
   * The guard this replaced declined only while an open row was younger than six hours. A pass that runs
   * longer than that is a real shape — a large store, a read-back spending its full propagation tolerance on
   * both gates, an outage the platform retries through — and its own row aged out from under it. So the next
   * trigger started a second pass over the same pointer: two passes, each confirming its own read-backs,
   * each writing a full-value replace of the master-key entry, and the loser deleting the key every row was
   * by then sealed under. Undecryptable, and reported green.
   *
   * Fails the moment the lock keys on an age rather than on the row. The second pass runs, stages key 3,
   * re-encrypts onto it — and pass A's promoted write, `{ currentVersion: "2", versions: { 1, 2 } }`, then
   * deletes key 3 underneath every row.
   */
  test("a pass whose row outlived every window still declines the second", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const store = new StubConfigStore({ bound: v1 });
    const journal = new Map<string, unknown>();

    // Pass A re-encrypts, is evicted before publishing the pointer, and never closes its own row.
    await expect(
      runAtRestKeyRotation(depsOver(store), journalledStep(journal, ["write-promoted-config", "mark-failure"]), {
        ...fastReadBack,
        now: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(Interrupted);
    expect(await keyVersionOf("a")).toBe(2);

    // A month later its row is still open, because nothing has closed it. Under the six-hour window this
    // was a dead pass at hour six; it is a held lock now, and that is the whole difference.
    await env.SECRETS.prepare("update pithy_secrets_rotations set started_at = ?")
      .bind(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .run();

    await expect(runAtRestKeyRotation(depsOver(store, store.boundConfig), syncStep, fastReadBack)).rejects.toThrow(
      "already running",
    );
    // Declined before anything was minted or written: one write in the whole test, pass A's staged one.
    expect(store.writes).toHaveLength(1);
    expect(store.boundConfig.currentVersion).toBe("1");
    expect(await keyVersionOf("a")).toBe(2);
  });

  /**
   * Replay (pithy-sh/pithy#329). A Workflow re-executes the body from the top and serves completed steps
   * from the journal, so anything computed outside a step is computed again on the newer clock. `now` is
   * the instant this rotation writes as `lastRotatedAt` — the field the cron's cadence check reads back.
   */
  test("records the instant the pass began, not the instant it resumed", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const store = new StubConfigStore({ bound: v1 });
    const journal = new Map<string, unknown>();

    await expect(
      runAtRestKeyRotation(depsOver(store), journalledStep(journal, ["stage-next-key"]), {
        ...fastReadBack,
        now: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(Interrupted);
    expect(store.writes).toEqual([]);

    // The body re-executes on the newer clock. That is the platform, not the test being clever.
    await runAtRestKeyRotation(depsOver(store), journalledStep(journal), {
      ...fastReadBack,
      now: new Date("2026-02-01T06:00:00.000Z"),
    });

    expect(store.lastWritten?.lastRotatedAt).toBe("2026-02-01T00:00:00.000Z");
    // And one rotation row, opened before the interruption, carries the whole pass — the history the
    // instant is dated against.
    const { results } = await env.SECRETS.prepare("select id, status from pithy_secrets_rotations").all<{
      id: number;
      status: string;
    }>();
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("success");
  });
});

describe("atRestInstanceId", () => {
  /**
   * Cloudflare refuses a duplicate instance id, which is what makes two concurrent passes impossible
   * rather than merely unlikely. Fails if the pointer or the day stops composing it.
   */
  test("two triggers on one day over one pointer are one instance; a moved pointer is another", () => {
    const morning = new Date("2026-02-01T03:00:00.000Z");
    const evening = new Date("2026-02-01T23:59:00.000Z");
    expect(atRestInstanceId("2", morning)).toBe(atRestInstanceId("2", evening));
    expect(atRestInstanceId("3", morning)).not.toBe(atRestInstanceId("2", morning));
    expect(atRestInstanceId("2", new Date("2026-02-02T03:00:00.000Z"))).not.toBe(atRestInstanceId("2", morning));
  });
});

/**
 * **The key set may not grow without bound, and the bound may never be a deletion (`#647`).**
 *
 * A row that will not decrypt keeps `failed > 0` forever. Retirement is gated on no row sitting on a
 * retiring version, so it never happens again — while the pass closes `success` and the set gains a key
 * every cadence. It fails *toward* keeping keys, which is why nobody would notice for a year, and it means
 * every key rotation was supposed to destroy is still live in the account's Secrets Store.
 *
 * The remedy is visibility and a ceiling, never a retirement: a corrupt ciphertext is not a missing key, and
 * deleting the key is the one move that makes a recoverable row certainly unrecoverable.
 */
describe("runAtRestKeyRotation — a key set that cannot retire", () => {
  test("a row that will not re-encrypt blocks the retirement, and the pass says by how many rows", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    await plantUndecryptable("broken", 1);
    const store = new StubConfigStore({ bound: v1 });

    // The pass that rotates has nothing due to retire, so a blocked count here would be an invention.
    // `failed` is two for one row because the batch loop meets it again on the pass that makes no progress
    // — a count of failures rather than of rows, which is what the field has always been.
    const first = await runAtRestKeyRotation(depsOver(store), syncStep, fastReadBack);
    expect(first).toMatchObject({ rotated: 1, failed: 2, pruned: false, retirementBlocked: 0 });

    // The next pass supersedes key 2 and is due to retire key 1 — and cannot, because the broken row is
    // still sealed under it. That is correct, and it is exactly the state that would otherwise be silent.
    const second = await runAtRestKeyRotation(depsOver(store, store.boundConfig), syncStep, fastReadBack);

    expect(second).toMatchObject({ pruned: false, retirementBlocked: 1 });
    // The key stays, because it is the only thing that could still open that row.
    expect(Object.keys(store.lastWritten?.versions ?? {}).sort()).toEqual(["1", "2", "3"]);
    expect((await latestRotation()).status).toBe("success");
  });

  /**
   * The ceiling, and it is checked **before a key is minted** — a ceiling checked afterwards is a ceiling
   * that has already been exceeded. Fails if the bound is dropped: the pass rotates happily, writes twice,
   * and the set reaches nine on its way to any number at all.
   */
  test("at the ceiling the pass refuses to mint another key, and says how many rows are in the way", async () => {
    const full = keySetOf(MAX_KEY_SET_SIZE);
    await plantUndecryptable("broken", 1);
    const store = new StubConfigStore({ bound: full });

    const thrown: unknown = await runAtRestKeyRotation(depsOver(store, full), syncStep, fastReadBack).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(PithyError);
    expect((thrown as PithyError).payload.message).toContain("reached its limit");
    expect((thrown as PithyError).payload.detail).toContain(
      `the key set holds ${MAX_KEY_SET_SIZE} versions against a ceiling of ${MAX_KEY_SET_SIZE}`,
    );
    // The number the operator acts on: how many rows are holding every retirement back.
    expect((thrown as PithyError).payload.detail).toContain("rows still sealed under a superseded version: 1");
    // Nothing was minted and nothing was written, so the store is exactly as it was and every key it holds
    // is still there — the refusal costs a reader nothing.
    expect(store.writes).toEqual([]);
    expect(store.boundConfig).toEqual(full);
    // And it is a finding somebody sees: the ledger row closes failed, which is what `lastAtRestRotation`
    // publishes on the manifest.
    expect(await latestRotation()).toMatchObject({
      status: "failed",
      error_message: "the at-rest key rotation did not finish",
    });
  });

  /** One under the ceiling is not the ceiling. A bound that refuses a healthy store is worse than none. */
  test("a set one short of the ceiling still rotates", async () => {
    const nearly = keySetOf(MAX_KEY_SET_SIZE - 1);
    const store = new StubConfigStore({ bound: nearly });

    const result = await runAtRestKeyRotation(depsOver(store, nearly), syncStep, fastReadBack);

    expect(result.newCurrentVersion).toBe(MAX_KEY_SET_SIZE);
    expect((await latestRotation()).status).toBe("success");
  });
});

/**
 * **What a pass may journal into `metadata_snapshot` (`#647`).**
 *
 * The column is the one place on this row a writer may put something of its own, it was typed `unknown`,
 * and the steps above it hold the key set and a decrypt failure in scope. It takes a `RotationSnapshot` now:
 * counts, and no member a key could arrive through.
 */
describe("runAtRestKeyRotation — the rotation row's snapshot", () => {
  async function snapshotRow(): Promise<{ metadata_snapshot: string | null; status: string }> {
    const row = await env.SECRETS.prepare(
      "select metadata_snapshot, status from pithy_secrets_rotations order by id desc limit 1",
    ).first<{ metadata_snapshot: string | null; status: string }>();
    if (!row) throw new Error("no rotation row");
    return row;
  }

  test("records the size of the key set the pass opened over, and nothing from it", async () => {
    const three = keySetOf(3);
    const store = new StubConfigStore({ bound: three });

    await runAtRestKeyRotation(depsOver(store, three), syncStep, fastReadBack);

    const row = await snapshotRow();
    // The count, exactly — this is the number that makes a key set growing every cadence visible in the
    // history a reviewer reads.
    expect(row.metadata_snapshot).toBe('{"keySetSize":3}');
    // And not one byte of the set itself. Asserted over the whole row, so a column that grew a copy of a
    // key fails here too.
    for (const key of Object.values(three.versions)) expect(JSON.stringify(row)).not.toContain(key);
  });
});
