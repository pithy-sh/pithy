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
  readonly writes: Array<{ value: string; previous: string }> = [];
  async write(value: string, previous: string): Promise<void> {
    this.writes.push({ value, previous });
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
    expect(Object.keys(JSON.parse(writer.writes[1]?.value ?? "{}").versions)).toEqual(["2"]);
    // The row re-encrypted to v2 still decrypts to the same value under the merged config.
    const merged = JSON.parse(writer.writes[0]?.value ?? "{}") as EncryptionConfig;
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
});
