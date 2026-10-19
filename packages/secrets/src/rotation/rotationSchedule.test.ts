// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { defineSecretRegistry, type SecretRegistryEntry } from "../registry";
import {
  parseStampedRotations,
  planValueRotations,
  type StampedRotation,
  stampedEntry,
  stampedRotations,
  valueRotationInstanceId,
} from "./rotationSchedule";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-10-18T03:00:00.000Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

const minted: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  devValue: "random",
  origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
  rotation: { kind: "local" },
  rotateEveryDays: 90,
  overlap: { days: 7, minimumDays: 7, reencrypt: ["auth-jwks"] },
};
const manual: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: false,
  valueType: "text",
  origin: { kind: "obtained", issuer: "github", documentation: "https://github.com/settings/developers" },
  rotation: { kind: "manual", issuer: "github", documentation: "https://github.com/settings/developers" },
  rotateEveryDays: 30,
};
const provider: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  origin: { kind: "helped", issuer: "cloudflare", needs: { cloudflare: ["com.cloudflare.api.account"] } },
  rotation: { kind: "provider", issuer: "cloudflare" },
  rotateEveryDays: 30,
};

const registry = defineSecretRegistry({
  "auth-session-secret": minted,
  "github-client-secret": manual,
  "turnstile-secret": provider,
  "shared-hmac": { ...minted, backend: "cf-secrets-store", scope: "global", overlap: { days: 7, minimumDays: 7 } },
  "no-schedule": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
});

describe("stampedRotations — what provisioning writes into the manager (#602)", () => {
  test("carries every named secret with a period, and nothing a function or a value could ride in", () => {
    const stamped = stampedRotations(registry);
    expect(stamped.map((one) => one.name)).toEqual([
      "auth-session-secret",
      "github-client-secret",
      "shared-hmac",
      "turnstile-secret",
    ]);
    expect(stamped[0]).toEqual({
      name: "auth-session-secret",
      backend: "d1",
      scope: "environment",
      rotatable: true,
      valueType: "text",
      devValue: "random",
      origin: minted.origin,
      rotation: { kind: "local" },
      rotateEveryDays: 90,
      overlap: { days: 7, minimumDays: 7, reencrypt: ["auth-jwks"] },
    });
  });

  test("a provider rotator does not cross: the manager sees a provider secret with none, and reports it", () => {
    const withRotator = defineSecretRegistry({
      "turnstile-secret": {
        ...provider,
        rotator: { roll: async () => ({ newValue: "x" }) },
        overlap: { days: 1, minimumDays: 1 },
      },
    });
    const [stamped] = stampedRotations(withRotator);
    expect(JSON.stringify(stamped)).not.toContain("roll");
    expect(
      planValueRotations({
        stamped: stampedRotations(withRotator),
        environment: "prod",
        globalEnvironment: "prod",
        lastSuccess: () => daysAgo(400),
        scheduledSince: () => daysAgo(400),
        now: NOW,
      }),
    ).toEqual([{ name: "turnstile-secret", decision: "report", reason: "no-rotator", overdue: true }]);
  });

  test("round-trips through the var it is stamped into, and the entry it rebuilds is one the registry accepts", () => {
    const text = JSON.stringify(stampedRotations(registry));
    const parsed = parseStampedRotations(text);
    expect(parsed).toEqual(stampedRotations(registry));
    for (const one of parsed) expect(() => defineSecretRegistry({ [one.name]: stampedEntry(one) })).not.toThrow();
  });

  test("an absent or empty var is no schedule at all", () => {
    expect(parseStampedRotations(undefined)).toEqual([]);
    expect(parseStampedRotations("")).toEqual([]);
  });

  test("a var that is not a schedule is refused, naming the var and never echoing it", () => {
    expect(() => parseStampedRotations("{not json")).toThrow(ValidationError);
    expect(() => parseStampedRotations('[{"name":"x"}]')).toThrow(/VALUE_ROTATIONS/);
  });

  test("a stamped entry the registry would refuse is refused again where it arrives", () => {
    const [one] = stampedRotations(registry) as [StampedRotation];
    const { overlap: _overlap, ...bare } = one;
    expect(() => defineSecretRegistry({ [bare.name]: stampedEntry(bare) })).toThrow(InternalError);
  });
});

describe("planValueRotations — what one cron tick does with each secret", () => {
  const stamped = stampedRotations(registry);
  const plan = (
    environment: string,
    lastSuccess: (name: string) => Date | null,
    scheduledSince: (name: string) => Date | null = lastSuccess,
  ) => planValueRotations({ stamped, environment, globalEnvironment: "prod", lastSuccess, scheduledSince, now: NOW });

  test("a due local secret starts, one not yet due does not, and a manual one is only reported overdue", () => {
    expect(plan("staging", (name) => (name === "auth-session-secret" ? daysAgo(91) : daysAgo(400)))).toEqual([
      { name: "auth-session-secret", decision: "start" },
      { name: "github-client-secret", decision: "report", reason: "manual", overdue: true },
      { name: "shared-hmac", decision: "not-owner" },
      { name: "turnstile-secret", decision: "report", reason: "no-rotator", overdue: true },
    ]);
    expect(plan("staging", () => daysAgo(89))[0]).toEqual({ name: "auth-session-secret", decision: "not-due" });
  });

  test("a secret with no history is given a baseline rather than rotated on first sight", () => {
    expect(plan("staging", () => null)[0]).toEqual({ name: "auth-session-secret", decision: "baseline" });
  });

  test("a secret a year old that the schedule has never seen is baselined, not rotated tonight", () => {
    // Its creation-time baseline is a year old; the period was added today, so the clock starts today.
    expect(
      plan(
        "staging",
        () => daysAgo(365),
        () => null,
      )[0],
    ).toEqual({
      name: "auth-session-secret",
      decision: "baseline",
    });
  });

  test("once the schedule has a start, the period counts from it rather than from the secret's creation", () => {
    const fromCreation = () => daysAgo(365);
    expect(plan("staging", fromCreation, () => daysAgo(10))[0]).toEqual({
      name: "auth-session-secret",
      decision: "not-due",
    });
    expect(plan("staging", fromCreation, () => daysAgo(91))[0]).toEqual({
      name: "auth-session-secret",
      decision: "start",
    });
  });

  test("only the last declared environment's manager rotates a global secret, however late it is", () => {
    const late = () => daysAgo(4000);
    expect(plan("staging", late).find((one) => one.name === "shared-hmac")).toEqual({
      name: "shared-hmac",
      decision: "not-owner",
    });
    expect(plan("prod", late).find((one) => one.name === "shared-hmac")).toEqual({
      name: "shared-hmac",
      decision: "start",
    });
    // A manager that was never told which environment owns global secrets owns none of them.
    expect(
      planValueRotations({ stamped, environment: "prod", lastSuccess: late, scheduledSince: late, now: NOW }).find(
        (one) => one.name === "shared-hmac",
      ),
    ).toEqual({ name: "shared-hmac", decision: "not-owner" });
  });

  test("a global d1 secret is refused even when a hand-built schedule carries one", () => {
    const [one] = stampedRotations(defineSecretRegistry({ "auth-session-secret": minted })) as [StampedRotation];
    const forged: StampedRotation = { ...one, scope: "global" };
    expect(
      planValueRotations({
        stamped: [forged],
        environment: "prod",
        globalEnvironment: "prod",
        lastSuccess: () => daysAgo(400),
        scheduledSince: () => daysAgo(400),
        now: NOW,
      }),
    ).toEqual([{ name: "auth-session-secret", decision: "refused", reason: "global-d1" }]);
  });
});

describe("valueRotationInstanceId", () => {
  test("one id per secret per UTC day, so a redelivered tick starts nothing new", () => {
    expect(valueRotationInstanceId("auth-session-secret", NOW)).toBe("value-auth-session-secret-2026-10-18");
    expect(valueRotationInstanceId("auth-session-secret", new Date("2026-10-18T23:59:59.000Z"))).toBe(
      valueRotationInstanceId("auth-session-secret", NOW),
    );
  });

  test("a name a Workflow id cannot hold is made into one that can, and stays distinct", () => {
    const id = valueRotationInstanceId("Weird.Name with spaces", NOW);
    expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/);
    expect(id).not.toBe(valueRotationInstanceId("Weird-Name-with-spaces", NOW));
    expect(valueRotationInstanceId("x".repeat(200), NOW).length).toBeLessThanOrEqual(100);
  });
});
