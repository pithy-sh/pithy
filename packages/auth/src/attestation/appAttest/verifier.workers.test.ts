// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../../data/tables";
import { AUTH_MIGRATION_ORDER } from "../../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../../migrations/set";
import { type AppAttestAuthority, appAttestAuthority } from "../../test-utils/appAttestDevice";
import { issueChallenge } from "../challenge";
import { AttestationEnvironment } from "../config";
import type { AttestationVerification } from "../verifier";
import { requestBinding } from "../wire";
import { appAttestVerifier, appIdOf, developmentKeysAllowedIn, registerAppAttestKey } from "./verifier";

const APP = { teamId: "ABCDE12345", bundleId: "com.example.app" };
const APP_ID = appIdOf(APP);
const SETTINGS = AttestationEnvironment.parse({ ios: [APP] });
const db = () => authDatabase(env.DB);

let authority: AppAttestAuthority;

beforeEach(async () => {
  for (const row of (
    await env.DB.prepare("select name from sqlite_master where type = 'table' and name like 'pithy_%'").all<{
      name: string;
    }>()
  ).results) {
    await env.DB.prepare(`drop table if exists ${row.name}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!provider) throw new Error("no provider");
  await runMigrations(env.DB, provider);
  authority = await appAttestAuthority();
});

/** Attest a key over a fresh challenge and register it, as the key route does. */
async function register(
  options: { environment?: "production" | "development"; worker?: string | null; appId?: string } = {},
) {
  const { challenge } = await issueChallenge(db(), { now: new Date(), expiresIn: 300 });
  const key = await authority.attest({
    appId: options.appId ?? APP_ID,
    clientDataHash: await requestBinding(challenge, new Uint8Array(0)),
    environment: options.environment,
  });
  const verdict = await registerAppAttestKey({
    db: db(),
    challenge,
    keyId: key.keyId,
    attestation: key.attestation,
    apps: [APP],
    environment: options.worker === undefined ? "prod" : options.worker,
    root: authority.root,
    now: new Date(),
  });
  return { key, verdict, challenge };
}

function verification(overrides: Partial<AttestationVerification>): AttestationVerification {
  return {
    presented: { platform: "ios", challenge: "c", assertion: "" },
    binding: new Uint8Array(32).fill(2),
    environment: "prod",
    settings: SETTINGS,
    db: db(),
    env: {},
    now: new Date(),
    ...overrides,
  };
}

describe("developmentKeysAllowedIn", () => {
  test("allows development keys where the test assertion is allowed, and nowhere else", () => {
    expect(developmentKeysAllowedIn("staging")).toBe(true);
    expect(developmentKeysAllowedIn("dev")).toBe(true);
    expect(developmentKeysAllowedIn("prod")).toBe(false);
    expect(developmentKeysAllowedIn("live")).toBe(false);
    expect(developmentKeysAllowedIn(null)).toBe(false);
  });
});

describe("registerAppAttestKey", () => {
  test("registers a key attested over SHA-256 of the challenge", async () => {
    const { verdict } = await register();
    expect(verdict).toEqual({ ok: true });
  });

  test("spends the challenge even when the attestation fails, so it cannot be retried", async () => {
    const { challenge } = await register({ appId: "ABCDE12345.com.example.impostor" });
    const again = await registerAppAttestKey({
      db: db(),
      challenge,
      keyId: "x",
      attestation: "x",
      apps: [APP],
      environment: "prod",
      root: authority.root,
      now: new Date(),
    });
    expect(again).toEqual({ ok: false, reason: expect.stringMatching(/^challenge: .*already used/) });
  });

  test("accepts a development key in staging", async () => {
    expect((await register({ environment: "development", worker: "staging" })).verdict).toEqual({ ok: true });
  });

  test("refuses a development key in prod, naming the AAGUID check", async () => {
    expect((await register({ environment: "development" })).verdict).toEqual({
      ok: false,
      reason: expect.stringMatching(/^aaguid: /),
    });
  });

  test("refuses where no iOS app is allowed", async () => {
    const { challenge } = await issueChallenge(db(), { now: new Date(), expiresIn: 300 });
    const verdict = await registerAppAttestKey({
      db: db(),
      challenge,
      keyId: "x",
      attestation: "x",
      apps: [],
      environment: "prod",
      root: authority.root,
      now: new Date(),
    });
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^rpIdHash: /) });
  });

  test.each([
    ["a key id that is not 32 bytes", "AAAA", "keyId"],
    ["an attestation that is not base64", "!", "format"],
  ])("refuses %s", async (_, value, check) => {
    const { challenge } = await issueChallenge(db(), { now: new Date(), expiresIn: 300 });
    const verdict = await registerAppAttestKey({
      db: db(),
      challenge,
      keyId: check === "keyId" ? value : btoa("k".repeat(32)),
      attestation: check === "format" ? value : "AAAA",
      apps: [APP],
      environment: "prod",
      root: authority.root,
      now: new Date(),
    });
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(new RegExp(`^${check}: `)) });
  });
});

describe("appAttestVerifier", () => {
  test("accepts an assertion from a registered key over the binding, and refuses its replay", async () => {
    const { key } = await register();
    const binding = new Uint8Array(32).fill(5);
    const assertion = await key.assert({ appId: APP_ID, clientDataHash: binding, counter: 1 });
    const presented = { platform: "ios" as const, challenge: "c", assertion, keyId: key.keyId };
    expect(await appAttestVerifier.verify(verification({ presented, binding }))).toEqual({ ok: true });
    expect(await appAttestVerifier.verify(verification({ presented, binding }))).toEqual({
      ok: false,
      reason: expect.stringMatching(/^counter: /),
    });
  });

  test("refuses an assertion with no key id", async () => {
    expect(await appAttestVerifier.verify(verification({}))).toEqual({
      ok: false,
      reason: expect.stringMatching(/^keyId: /),
    });
  });

  test("refuses a key whose app is no longer allowed", async () => {
    const { key } = await register();
    const assertion = await key.assert({ appId: APP_ID, clientDataHash: new Uint8Array(32), counter: 1 });
    const settings = AttestationEnvironment.parse({ ios: [{ ...APP, bundleId: "com.example.other" }] });
    const verdict = await appAttestVerifier.verify(
      verification({ presented: { platform: "ios", challenge: "c", assertion, keyId: key.keyId }, settings }),
    );
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^rpIdHash: /) });
  });

  test("refuses a development key once the Worker is production", async () => {
    const { key } = await register({ environment: "development", worker: "staging" });
    const assertion = await key.assert({ appId: APP_ID, clientDataHash: new Uint8Array(32), counter: 1 });
    const verdict = await appAttestVerifier.verify(
      verification({ presented: { platform: "ios", challenge: "c", assertion, keyId: key.keyId } }),
    );
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^aaguid: /) });
  });

  test("refuses an assertion that is not base64", async () => {
    const { key } = await register();
    const verdict = await appAttestVerifier.verify(
      verification({ presented: { platform: "ios", challenge: "c", assertion: "!!", keyId: key.keyId } }),
    );
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/^format: /) });
  });
});
