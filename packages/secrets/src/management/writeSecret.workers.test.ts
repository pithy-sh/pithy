// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import { secretsTables } from "../data/tables";
import { SecretAlreadyExistsError, SecretNotFoundError } from "../error/errors";
import { secrets_0001_init } from "../migrations/0001_init";
import { RotationTracker } from "../store/rotationTracker";
import { SystemSecretsStore } from "../store/systemSecretsStore";
import { runWriteSecret, type WriteSecretDeps } from "./writeSecret";

function keyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const config: EncryptionConfig = {
  currentVersion: "1",
  versions: { "1": keyB64() },
  lastRotatedAt: "2026-01-01T00:00:00.000Z",
};

function deps(): WriteSecretDeps {
  const db = createDatabase(env.SECRETS, secretsTables);
  return { store: new SystemSecretsStore(db, config), tracker: RotationTracker.fromD1(env.SECRETS) };
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("runWriteSecret", () => {
  test("create writes a one-version envelope and seeds a baseline for a rotatable secret", async () => {
    const d = deps();
    await runWriteSecret(d, { mode: "create", name: "signing-key", value: "k", valueType: "text", rotatable: true });

    expect(await d.store.getValue("signing-key")).toEqual({ currentVersion: "1", versions: { "1": "k" } });
    expect(await d.tracker.getLatestSuccess("signing-key")).toBeInstanceOf(Date);
  });

  test("create does not seed a baseline for a non-rotatable secret", async () => {
    const d = deps();
    await runWriteSecret(d, { mode: "create", name: "api-token", value: "t", valueType: "text", rotatable: false });

    expect(await d.tracker.getLatestSuccess("api-token")).toBeNull();
  });

  test("create rejects an existing name", async () => {
    const d = deps();
    await runWriteSecret(d, { mode: "create", name: "x", value: "v", valueType: "text", rotatable: false });

    await expect(
      runWriteSecret(d, { mode: "create", name: "x", value: "v2", valueType: "text", rotatable: false }),
    ).rejects.toBeInstanceOf(SecretAlreadyExistsError);
  });

  test("update rejects a missing name", async () => {
    await expect(
      runWriteSecret(deps(), { mode: "update", name: "nope", value: "v", valueType: "text", rotatable: false }),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  test("update replaces the value in place", async () => {
    const d = deps();
    await runWriteSecret(d, { mode: "create", name: "x", value: "v1", valueType: "text", rotatable: false });
    await runWriteSecret(d, { mode: "update", name: "x", value: "v2", valueType: "text", rotatable: false });

    expect(await d.store.getValue("x")).toEqual({ currentVersion: "1", versions: { "1": "v2" } });
  });

  test("stores a json value as-is without validating its shape — that is the CLI's job", async () => {
    const d = deps();
    // A payload the registry schema would reject is still written: a not-yet-deployed secret's
    // schema isn't in the worker, so the worker trusts the CLI's client-side validation.
    const raw = JSON.stringify({ unexpected: true });
    await runWriteSecret(d, { mode: "create", name: "emailer", value: raw, valueType: "json", rotatable: false });

    expect(await d.store.getValue("emailer")).toEqual({ currentVersion: "1", versions: { "1": raw } });
  });

  /**
   * **`probe` is the read the CLI cannot do for itself**, and the two properties below are exactly what
   * `mintSecrets.test.ts` models in its fake managers. Pinned here, against a real D1 and a real master
   * key, so that model is a statement about this code rather than about itself.
   *
   * It replaced `ensure`. `ensure` wrote when absent and skipped **silently** when present, which is a
   * per-environment answer to the cross-environment question a `global` secret asks — and the silence
   * is what let a half-written fan-out complete with a second value. Nothing here is allowed to be
   * quiet about a value that is already there any more: the caller asks, then writes with `create`,
   * which raises.
   */
  test("probe reports a secret that is there, and writes nothing", async () => {
    const d = deps();
    await runWriteSecret(d, {
      mode: "create",
      name: "session",
      value: "the-live-one",
      valueType: "text",
      rotatable: true,
    });
    const baseline = await d.tracker.getLatestSuccess("session");

    expect(await runWriteSecret(d, { mode: "probe", name: "session" })).toBe("present");

    // Untouched: not the value, not the envelope's version, not the rotation baseline.
    expect(await d.store.getValue("session")).toEqual({ currentVersion: "1", versions: { "1": "the-live-one" } });
    expect(await d.tracker.getLatestSuccess("session")).toEqual(baseline);
  });

  test("probe reports a secret that is not there, and creates nothing", async () => {
    const d = deps();

    expect(await runWriteSecret(d, { mode: "probe", name: "session" })).toBe("absent");

    expect(await d.store.getValue("session")).toBeUndefined();
    expect(await d.tracker.getLatestSuccess("session")).toBeNull();
  });

  /**
   * The other half of the model, and the one that closes the race probing cannot: two runs both find a
   * global secret absent, and the loser must be refused rather than fanning its own value onward.
   */
  test("create raises on a name already present rather than skipping it", async () => {
    const d = deps();
    await runWriteSecret(d, { mode: "create", name: "session", value: "theirs", valueType: "text", rotatable: true });

    await expect(
      runWriteSecret(d, { mode: "create", name: "session", value: "ours", valueType: "text", rotatable: true }),
    ).rejects.toThrow(SecretAlreadyExistsError);
    expect(await d.store.getValue("session")).toEqual({ currentVersion: "1", versions: { "1": "theirs" } });
  });

  /** The outcome is the manager's whole answer, and it is what a caller decides on. */
  test("reports what it did — written, and deleted", async () => {
    const d = deps();

    expect(
      await runWriteSecret(d, { mode: "create", name: "x", value: "v", valueType: "text", rotatable: false }),
    ).toBe("written");
    expect(
      await runWriteSecret(d, { mode: "update", name: "x", value: "v2", valueType: "text", rotatable: false }),
    ).toBe("written");
    expect(await runWriteSecret(d, { mode: "delete", name: "x" })).toBe("deleted");
  });

  test("delete removes the secret and purges its rotation history", async () => {
    const d = deps();
    await runWriteSecret(d, { mode: "create", name: "x", value: "v", valueType: "text", rotatable: true });

    await runWriteSecret(d, { mode: "delete", name: "x" });

    expect(await d.store.getValue("x")).toBeUndefined();
    expect(await d.tracker.getLatestSuccess("x")).toBeNull();
  });
});
