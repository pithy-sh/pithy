// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import { initialVersionedValue } from "../crypto/versionedValue";
import { secretsTables } from "../data/tables";
import type { ConfigWriter } from "../manager/configWriter";
import { secrets_0001_init } from "../migrations/0001_init";
import { RotationTracker } from "../store/rotationTracker";
import { SystemSecretsStore } from "../store/systemSecretsStore";
import { runAtRestKeyRotation, type StepRunner } from "./atRestKeyRotation";

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

/** A synchronous step runner — runs each callback immediately (no durable replay in tests). */
const syncStep: StepRunner = { do: (_name, fn) => fn() };

class StubWriter implements ConfigWriter {
  readonly writes: string[] = [];
  async write(value: string): Promise<void> {
    this.writes.push(value);
  }
}

const db = () => createDatabase(env.SECRETS, secretsTables);

async function latestRotation(): Promise<{ status: string; name: string }> {
  const row = await env.SECRETS.prepare(
    "select status, name from pithy_secrets_rotations order by id desc limit 1",
  ).first<{ status: string; name: string }>();
  if (!row) throw new Error("no rotation row");
  return row;
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(db());
});

describe("runAtRestKeyRotation", () => {
  test("generates a key, re-encrypts rows, prunes old keys, and records success", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const writer = new StubWriter();

    const result = await runAtRestKeyRotation(
      { db: db(), config: v1, configWriter: writer, tracker: RotationTracker.fromD1(env.SECRETS) },
      syncStep,
      { now: new Date("2026-02-01T00:00:00.000Z") },
    );

    expect(result).toMatchObject({ newCurrentVersion: 2, rotated: 1, failed: 0, pruned: true });
    // Two write-backs: the merged config (keys 1 + 2), then the pruned config (key 2 only).
    expect(writer.writes).toHaveLength(2);
    expect(Object.keys(JSON.parse(writer.writes[1] ?? "{}").versions)).toEqual(["2"]);
    // The row re-encrypted to v2 still decrypts to the same value under the merged config.
    const merged = JSON.parse(writer.writes[0] ?? "{}") as EncryptionConfig;
    expect(await new SystemSecretsStore(db(), merged).getValue("a")).toEqual({
      currentVersion: "1",
      versions: { "1": "va" },
    });
    expect(await latestRotation()).toEqual({ status: "success", name: "__at_rest_key_rotation__" });
  });

  test("an empty store rotates the key and prunes with nothing to re-encrypt", async () => {
    const writer = new StubWriter();

    const result = await runAtRestKeyRotation(
      { db: db(), config: v1, configWriter: writer, tracker: RotationTracker.fromD1(env.SECRETS) },
      syncStep,
    );

    expect(result).toMatchObject({ rotated: 0, failed: 0, pruned: true });
    expect((await latestRotation()).status).toBe("success");
  });

  test("a write-back failure marks the rotation failed and rethrows", async () => {
    const failingWriter: ConfigWriter = {
      write: async () => {
        throw new Error("cf api down");
      },
    };

    await expect(
      runAtRestKeyRotation(
        { db: db(), config: v1, configWriter: failingWriter, tracker: RotationTracker.fromD1(env.SECRETS) },
        syncStep,
      ),
    ).rejects.toThrow("cf api down");

    expect((await latestRotation()).status).toBe("failed");
  });

  /**
   * `#386`, from the site that violated it.
   *
   * This catch is reached from decryption, envelope decoding and config parsing, and it used to write
   * `cause.message` into `error_message`. So the exception is planted to look like what those paths
   * actually throw: a sentence carrying key material. The row must hold the code's fixed text and no part
   * of it.
   *
   * Asserted over the whole row rather than over `error_message` alone, so a future column that captured
   * the same text — a `metadata_snapshot` taken "for debugging" — fails here too.
   */
  test("a failure writes the code's fixed sentence, and nothing the exception said", async () => {
    const PLANTED = "decrypt failed: key sk_live_PLANTED_KEY_MATERIAL, iv AAAAAAAAAAAAAAAA";
    const leakingWriter: ConfigWriter = {
      write: async () => {
        throw new Error(PLANTED);
      },
    };

    // The exception still travels — unchanged, to the Workflow, where a `PithyError`'s `detail` is the
    // right place for it and the HTTP codec strips it. What must not travel is the column.
    await expect(
      runAtRestKeyRotation(
        { db: db(), config: v1, configWriter: leakingWriter, tracker: RotationTracker.fromD1(env.SECRETS) },
        syncStep,
      ),
    ).rejects.toThrow(PLANTED);

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
 * Replay (pithy-sh/pithy#329).
 *
 * A Workflow does not resume inside the step it died in. It re-executes this delegate from the top and
 * serves every completed step from the journal, so anything the body computes outside a step is computed
 * again on the newer clock. `now` is the instant this rotation writes as `lastRotatedAt` — the field the
 * cron's cadence check reads back — and it was read in the body.
 *
 * **Confirmed, not assumed, that it carries no liveness meaning.** The only reader of `lastRotatedAt` is
 * `isRotationDue`, a cadence question asked in days by a cron that starts nothing while an instance is
 * running; the rotation row's own `startedAt`/`completedAt` are written by `RotationTracker` inside its
 * steps and read by `admin/status` for display. Nothing re-drives this pass off a timestamp, so freezing
 * the instant strands no live work — which is exactly what it would do in the email scheduler.
 */
describe("runAtRestKeyRotation — a replayed pass", () => {
  /** The interruption a resumed Workflow is the recovery from. Not a `PithyError`: this is the platform. */
  class Interrupted extends Error {}

  /**
   * The Workflow journal, structurally: a completed step returns what it returned the first time, and a
   * step never reached runs. `interruptBefore` kills the pass just before a named step, once, so a second
   * call over the same journal is a genuine resume rather than a re-invocation of one callback.
   */
  function journalledStep(journal: Map<string, unknown>, interruptBefore?: string): StepRunner {
    const runner = {
      armed: interruptBefore !== undefined,
      async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (journal.has(name)) return journal.get(name) as T;
        if (runner.armed && name === interruptBefore) {
          runner.armed = false;
          throw new Interrupted(`the pass died before ${name}`);
        }
        const result = await fn();
        journal.set(name, result);
        return result;
      },
    };
    return runner;
  }

  const PASS_STARTED = new Date("2026-02-01T00:00:00.000Z");
  /** Six hours on. An ordinary Workflow backoff, not a pathological outage. */
  const RESUMED = new Date("2026-02-01T06:00:00.000Z");

  test("records the instant the pass began, not the instant it resumed", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const writer = new StubWriter();
    const deps = { db: db(), config: v1, configWriter: writer, tracker: RotationTracker.fromD1(env.SECRETS) };
    const journal = new Map<string, unknown>();

    // Dies before the key is generated — the only window in which the body's clock still decides anything,
    // because `generate-key` journals `lastRotatedAt` along with the key once it completes.
    await expect(
      runAtRestKeyRotation(deps, journalledStep(journal, "generate-key"), { now: PASS_STARTED }),
    ).rejects.toBeInstanceOf(Interrupted);
    expect(writer.writes).toEqual([]);

    // The body re-executes on the newer clock. That is the platform, not the test being clever.
    await runAtRestKeyRotation(deps, journalledStep(journal), { now: RESUMED });

    const merged = JSON.parse(writer.writes[0] ?? "{}") as EncryptionConfig;
    expect(merged.lastRotatedAt).toBe(PASS_STARTED.toISOString());
  });

  test("and one rotation row, opened before the interruption, carries the whole pass", async () => {
    // The pass instant would be worth nothing on a row the resume replaced: a history joined on the
    // rotation this pass opened is the thing the instant is dated against.
    const writer = new StubWriter();
    const deps = { db: db(), config: v1, configWriter: writer, tracker: RotationTracker.fromD1(env.SECRETS) };
    const journal = new Map<string, unknown>();

    await expect(
      runAtRestKeyRotation(deps, journalledStep(journal, "generate-key"), { now: PASS_STARTED }),
    ).rejects.toBeInstanceOf(Interrupted);
    await runAtRestKeyRotation(deps, journalledStep(journal), { now: RESUMED });

    const { results } = await env.SECRETS.prepare("select id, status from pithy_secrets_rotations").all<{
      id: number;
      status: string;
    }>();
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("success");
  });
});
