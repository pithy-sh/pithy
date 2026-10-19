// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { decodeVersionedValue, encodeVersionedValue, initialVersionedValue } from "../crypto/versionedValue";
import { secretsTables } from "../data/tables";
import { secretBindingName } from "../env/bindingName";
import { secretsMigrations } from "../migrations/secretsMigrations";
import { defineSecretRegistry, type SecretRegistryEntry } from "../registry";
import { recordReencryption } from "../rotation/reencryption";
import { rotationStoreEntry, stampedRotations } from "../rotation/rotationSchedule";
import type { ValueRotationSteps } from "../rotation/valueRotation";
import { SystemSecretsStore } from "../store/systemSecretsStore";
import { runValueRotationWorkflow, type ValueRotationPayload } from "./valueRotationWorkflow";
import manager, { type SecretsManagerEnv } from "./worker";
import { runWriteWorkflow } from "./writeWorkflow";

const DAY_MS = 86_400_000;
const PROJECT = "acme";

/** No durable replay in a test: a step runs once, a sleep returns. */
const syncSteps: ValueRotationSteps = { do: (_name, fn) => fn(), sleep: async () => undefined };

const minted = {
  rotatable: true,
  valueType: "text",
  devValue: "random",
  origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
  rotation: { kind: "local" },
} as const satisfies Omit<SecretRegistryEntry, "backend" | "scope">;

/** The project's registry as provisioning would aggregate it: one of each case the cron decides between. */
const registry = defineSecretRegistry({
  "app-session-secret": {
    ...minted,
    backend: "d1",
    scope: "environment",
    rotateEveryDays: 90,
    overlap: { days: 7, minimumDays: 7 },
  },
  "auth-session-secret": {
    ...minted,
    backend: "d1",
    scope: "environment",
    rotateEveryDays: 90,
    overlap: { days: 7, minimumDays: 7, reencrypt: ["auth-jwks"] },
  },
  "fresh-secret": {
    ...minted,
    backend: "d1",
    scope: "environment",
    rotateEveryDays: 90,
    overlap: { days: 7, minimumDays: 7 },
  },
  "github-client-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    origin: { kind: "obtained", issuer: "github", documentation: "https://github.com/settings/developers" },
    rotation: { kind: "manual", issuer: "github", documentation: "https://github.com/settings/developers" },
    rotateEveryDays: 30,
  },
  "link-signing-key": {
    ...minted,
    backend: "cf-secrets-store",
    scope: "environment",
    rotateEveryDays: 90,
    overlap: { days: 7, minimumDays: 7 },
  },
  "shared-hmac": {
    ...minted,
    backend: "cf-secrets-store",
    scope: "global",
    rotateEveryDays: 90,
    overlap: { days: 7, minimumDays: 7 },
  },
});

/** The account's Secrets Store, by entry name: what REST writes and what each manager's binding reads. */
let entries: Map<string, string>;

/** One manager's env, with its Workflow bindings running the real bodies in-process. */
function managerEnv(environment: "staging" | "prod"): SecretsManagerEnv {
  const bindings: Record<string, { get(): Promise<string> }> = {};
  for (const name of ["link-signing-key", "shared-hmac"] as const) {
    const scope = registry[name].scope;
    const entry = rotationStoreEntry(PROJECT, environment, { name, scope });
    bindings[secretBindingName(name)] = { get: async () => entries.get(entry) as string };
  }
  const self: SecretsManagerEnv = {
    SECRETS: env.SECRETS,
    SECRETS_ENCRYPTION_KEYS: env.SECRETS_ENCRYPTION_KEYS,
    ENVIRONMENT: environment,
    PROJECT,
    GLOBAL_ENVIRONMENT: "prod",
    VALUE_ROTATIONS: JSON.stringify(stampedRotations(registry)),
    AT_REST_ROTATION: { create: async () => undefined },
    VALUE_ROTATION: {
      create: async (options) => {
        await runValueRotationWorkflow(self, options?.params as ValueRotationPayload, syncSteps, {
          writeEntry: async (entry, text) => {
            if (!entries.has(entry)) throw new Error(`no entry ${entry}`);
            entries.set(entry, text);
          },
          emit: async () => undefined,
          instanceId: options?.id ?? "test",
        });
      },
    },
    RUNTIME_CF_API_TOKEN: "unused",
    CLOUDFLARE_ACCOUNT_ID: "unused",
    SECRETS_STORE_ID: "unused",
    ...bindings,
  };
  return self;
}

/** Seed one d1 secret through the write Workflow, then push its baseline `days` into the past. */
async function seedD1(name: string, days: number): Promise<void> {
  await runWriteWorkflow(managerEnv("staging"), {
    mode: "create",
    name,
    value: `${name}-v1`,
    valueType: "text",
    rotatable: true,
  });
  await backdate(name, days);
}

/** Record a baseline for a name the ledger has not seen, `days` ago. */
async function baseline(name: string, days: number): Promise<void> {
  const at = Date.now() - days * DAY_MS;
  await env.SECRETS.prepare(
    "insert into pithy_secrets_rotations (name, started_at, completed_at, status, trigger, rotated_by) values (?, ?, ?, 'success', 'baseline', 'baseline')",
  )
    .bind(name, at, at)
    .run();
}

async function backdate(name: string, days: number): Promise<void> {
  const at = Date.now() - days * DAY_MS;
  await env.SECRETS.prepare("update pithy_secrets_rotations set started_at = ?, completed_at = ? where name = ?")
    .bind(at, at, name)
    .run();
}

async function stored(name: string) {
  return (await SystemSecretsStore.fromEnv(managerEnv("staging"))).getValue(name);
}

async function rows(name: string) {
  const found = await env.SECRETS.prepare(
    "select trigger, status from pithy_secrets_rotations where name = ? order by id",
  )
    .bind(name)
    .all<{ trigger: string; status: string }>();
  return found.results;
}

beforeEach(async () => {
  for (const table of [
    "pithy_secrets_reencryptions",
    "pithy_secrets_tables",
    "pithy_secrets_rotations",
    "pithy_secrets_system_secrets",
  ]) {
    await env.SECRETS.prepare(`drop table if exists ${table}`).run();
  }
  const db = createDatabase(env.SECRETS, secretsTables);
  for (const migration of Object.values(secretsMigrations)) await migration.up(db);
  entries = new Map([
    [`${PROJECT}-staging-link-signing-key`, encodeVersionedValue(initialVersionedValue("link-staging-v1"))],
    [`${PROJECT}-prod-link-signing-key`, encodeVersionedValue(initialVersionedValue("link-prod-v1"))],
    [`${PROJECT}-global-shared-hmac`, encodeVersionedValue(initialVersionedValue("hmac-v1"))],
  ]);
});

describe("the manager's scheduled() — value rotation on each secret's own period (#602)", () => {
  test("a due local secret rotates, one not yet due does not, and a manual one is only reported", async () => {
    await seedD1("app-session-secret", 91);
    await seedD1("fresh-secret", 10);
    await runWriteWorkflow(managerEnv("staging"), {
      mode: "create",
      name: "github-client-secret",
      value: "gh-v1",
      valueType: "text",
      rotatable: false,
    });
    await baseline("github-client-secret", 400);

    await manager.scheduled(undefined, managerEnv("staging"));

    // Rotated, then retired: the previous version is gone and the successor is current.
    const rotated = await stored("app-session-secret");
    expect(rotated?.currentVersion).toBe("2");
    expect(Object.keys(rotated?.versions ?? {})).toEqual(["2"]);
    expect(rotated?.versions["2"]).not.toBe("app-session-secret-v1");
    // Recorded with trigger `cron`, closed success — so it stops reporting overdue.
    expect(await rows("app-session-secret")).toEqual([
      { trigger: "baseline", status: "success" },
      { trigger: "cron", status: "success" },
    ]);

    expect(await stored("fresh-secret")).toEqual(initialVersionedValue("fresh-secret-v1"));
    expect(await rows("fresh-secret")).toEqual([{ trigger: "baseline", status: "success" }]);
    expect(await stored("github-client-secret")).toEqual(initialVersionedValue("gh-v1"));
    expect(await rows("github-client-secret")).toEqual([{ trigger: "baseline", status: "success" }]);
  });

  test("a value in D1 and a value in the Cloudflare Secrets Store both rotate", async () => {
    await seedD1("app-session-secret", 91);
    await baseline("link-signing-key", 91);

    await manager.scheduled(undefined, managerEnv("staging"));

    expect((await stored("app-session-secret"))?.currentVersion).toBe("2");
    const link = decodeVersionedValue(entries.get(`${PROJECT}-staging-link-signing-key`) as string);
    expect(link.currentVersion).toBe("2");
    expect(Object.keys(link.versions)).toEqual(["2"]);
    expect(link.versions["2"]).not.toBe("link-staging-v1");
    // Only this environment's entry: production's link key is production's to rotate.
    expect(entries.get(`${PROJECT}-prod-link-signing-key`)).toBe(
      encodeVersionedValue(initialVersionedValue("link-prod-v1")),
    );
  });

  test("staging's manager never rotates a global secret however overdue it is, and production's does", async () => {
    await baseline("shared-hmac", 4000);
    const before = entries.get(`${PROJECT}-global-shared-hmac`);

    await manager.scheduled(undefined, managerEnv("staging"));
    expect(entries.get(`${PROJECT}-global-shared-hmac`)).toBe(before);
    expect(await rows("shared-hmac")).toEqual([{ trigger: "baseline", status: "success" }]);

    await manager.scheduled(undefined, managerEnv("prod"));
    const shared = decodeVersionedValue(entries.get(`${PROJECT}-global-shared-hmac`) as string);
    expect(shared.currentVersion).toBe("2");
    expect(shared.versions["2"]).not.toBe("hmac-v1");
  });

  test("a value rotation of a global secret is refused by the manager that does not own it, whoever started it", async () => {
    const [shared] = stampedRotations(defineSecretRegistry({ "shared-hmac": registry["shared-hmac"] }));
    await expect(
      runValueRotationWorkflow(managerEnv("staging"), { rotation: shared }, syncSteps, {
        writeEntry: async () => undefined,
        emit: async () => undefined,
        instanceId: "forged",
      }),
    ).rejects.toThrow(/does not rotate global secrets/);
  });

  test("retirement waits for the JWKS to move off the old version, and retires once it has", async () => {
    await seedD1("auth-session-secret", 91);
    const held = await runValueRotationWorkflow(
      managerEnv("staging"),
      { rotation: stampedRotations(registry).find((one) => one.name === "auth-session-secret") as never },
      syncSteps,
      { writeEntry: async () => undefined, emit: async () => undefined, instanceId: "first" },
    );
    expect(held).toMatchObject({ status: "rotated", version: "2", retired: [], held: ["auth-jwks"] });
    expect(Object.keys((await stored("auth-session-secret"))?.versions ?? {})).toEqual(["1", "2"]);
    expect(await rows("auth-session-secret")).toEqual([
      { trigger: "baseline", status: "success" },
      { trigger: "cron", status: "success" },
      { trigger: "cron", status: "failed" },
    ]);

    // The owner re-encrypts under version 3 this time, and the next rotation retires both earlier versions.
    await backdate("auth-session-secret", 91);
    await recordReencryption(createDatabase(env.SECRETS, secretsTables), {
      name: "auth-session-secret",
      dependent: "auth-jwks",
      version: "3",
    });
    const retired = await runValueRotationWorkflow(
      managerEnv("staging"),
      { rotation: stampedRotations(registry).find((one) => one.name === "auth-session-secret") as never },
      syncSteps,
      { writeEntry: async () => undefined, emit: async () => undefined, instanceId: "second" },
    );
    expect(retired).toEqual({ status: "rotated", version: "3", retired: ["1", "2"], held: [] });
    expect(Object.keys((await stored("auth-session-secret"))?.versions ?? {})).toEqual(["3"]);
  });

  test("a secret with no history is baselined on the first tick, not rotated", async () => {
    await runWriteWorkflow(managerEnv("staging"), {
      mode: "create",
      name: "app-session-secret",
      value: "v1",
      valueType: "text",
      rotatable: false,
    });
    await manager.scheduled(undefined, managerEnv("staging"));
    expect(await stored("app-session-secret")).toEqual(initialVersionedValue("v1"));
    expect(await rows("app-session-secret")).toEqual([{ trigger: "baseline", status: "success" }]);
  });

  test("the at-rest half failing does not stop the value half", async () => {
    await seedD1("app-session-secret", 91);
    const broken: SecretsManagerEnv = { ...managerEnv("staging") };
    broken.AT_REST_ROTATION = {
      create: async () => {
        throw new Error("at-rest binding unavailable");
      },
    };
    // The at-rest half sees an old key and tries to start; it throws, and the value half runs anyway.
    await expect(manager.scheduled(undefined, broken)).rejects.toThrow();
    expect((await stored("app-session-secret"))?.currentVersion).toBe("2");
  });
});
