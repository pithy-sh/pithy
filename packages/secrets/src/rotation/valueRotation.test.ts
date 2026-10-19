// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { describe, expect, test } from "vitest";
import { initialVersionedValue, type VersionedValue } from "../crypto/versionedValue";
import type { SecretRegistryEntry } from "../registry";
import type { SecretRotationOutcome } from "./rotateValue";
import { type RotationLedger, rotationClosure } from "./rotationLedger";
import {
  REENCRYPTION_CHECKS,
  REENCRYPTION_WAIT_MS,
  runValueRotation,
  type ValueRotationDeps,
  type ValueRotationSteps,
} from "./valueRotation";
import type { ValueRotator } from "./valueRotator";
import { envelopeVersionStore } from "./versionStore";

const DAY_MS = 86_400_000;

/** `auth-session-secret`'s shape: minted, local, rotatable, a week of overlap and the JWKS sealed under it. */
const session: SecretRegistryEntry = {
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

/**
 * A step runner that behaves the way the platform does where it matters here: a step whose body throws is
 * run again, up to its retry budget — **unless it declared it must not be.** Every step and every sleep is
 * logged in order, with the options the step declared.
 */
function platformSteps(budget = 3) {
  const log: { kind: "do" | "sleep"; name: string; retries?: false; ms?: number }[] = [];
  const steps: ValueRotationSteps = {
    async do(name, fn, options) {
      log.push({ kind: "do", name, ...(options?.retries === false ? { retries: false } : {}) });
      const limit = options?.retries === false ? 1 : budget;
      let last: unknown;
      for (let attempt = 0; attempt < limit; attempt++) {
        try {
          return await fn();
        } catch (error) {
          last = error;
        }
      }
      throw last;
    },
    async sleep(name, ms) {
      log.push({ kind: "sleep", name, ms });
    },
  };
  return { steps, log };
}

/** A ledger that records the closure each row got. */
function recordingLedger() {
  const rows: { name: string; closed?: ReturnType<typeof rotationClosure> }[] = [];
  const ledger: RotationLedger = {
    async open(name) {
      const row: { name: string; closed?: ReturnType<typeof rotationClosure> } = { name };
      rows.push(row);
      return {
        async close(outcome: SecretRotationOutcome) {
          row.closed = rotationClosure(outcome, "prod");
        },
      };
    },
  };
  return { ledger, rows };
}

/** Everything one run needs, over an in-memory envelope. Overridable per test. */
function harness(overrides: Partial<ValueRotationDeps> & { stored?: VersionedValue } = {}) {
  const held = new Map<string, VersionedValue>([
    ["auth-session-secret", overrides.stored ?? initialVersionedValue("v1")],
  ]);
  const events: AuditEventInput[] = [];
  const held_: string[] = [];
  const { ledger, rows } = recordingLedger();
  const deps: ValueRotationDeps = {
    name: "auth-session-secret",
    entry: session,
    environment: "prod",
    store: envelopeVersionStore({
      read: async (name) => held.get(name),
      write: async (name, value) => {
        held.set(name, value);
      },
    }),
    ledger,
    holdRetirement: async (name) => {
      held_.push(name);
    },
    pending: async () => [],
    emit: async (event) => {
      events.push(event);
    },
    rotatedBy: "auth-session-secret-20261018",
    sleep: async () => undefined,
    ...overrides,
  };
  return { deps, held, events, rows, holds: held_ };
}

describe("runValueRotation — rotate, wait out the overlap, retire (#602)", () => {
  test("appends a version, sleeps the declared overlap, then retires the version it replaced", async () => {
    const { deps, held, rows } = harness();
    const { steps, log } = platformSteps();
    const result = await runValueRotation(deps, steps);

    expect(result).toEqual({ status: "rotated", version: "2", retired: ["1"], held: [] });
    expect(held.get("auth-session-secret")?.currentVersion).toBe("2");
    expect(Object.keys(held.get("auth-session-secret")?.versions ?? {})).toEqual(["2"]);
    expect(rows).toEqual([{ name: "auth-session-secret", closed: { status: "success" } }]);
    // The overlap is a durable sleep between the two writes, never a timer inside a step.
    expect(log.find((entry) => entry.kind === "sleep")).toEqual({ kind: "sleep", name: "overlap", ms: 7 * DAY_MS });
    const order = log.map((entry) => entry.name);
    expect(order.indexOf("rotate")).toBeLessThan(order.indexOf("overlap"));
    expect(order.indexOf("overlap")).toBeLessThan(order.indexOf("retire"));
  });

  test("the version is live and the old one still verifies until the overlap ends", async () => {
    const { deps, held } = harness();
    let duringOverlap: VersionedValue | undefined;
    const { steps } = platformSteps();
    await runValueRotation(deps, {
      ...steps,
      async sleep(name, ms) {
        if (name === "overlap") duringOverlap = structuredClone(held.get("auth-session-secret"));
        await steps.sleep(name, ms);
      },
    });
    expect(duringOverlap?.currentVersion).toBe("2");
    expect(Object.keys(duringOverlap?.versions ?? {})).toEqual(["1", "2"]);
  });

  test("the rotate step declares it is never retried", async () => {
    const { deps } = harness();
    const { steps, log } = platformSteps();
    await runValueRotation(deps, steps);
    expect(log.find((entry) => entry.name === "rotate")).toEqual({ kind: "do", name: "rotate", retries: false });
  });

  test("a provider roll that lands and a store that fails calls the roller exactly once", async () => {
    const calls: string[] = [];
    const rotator: ValueRotator = {
      async roll() {
        calls.push("roll");
        return { newValue: "rolled-at-the-issuer" };
      },
    };
    const provider: SecretRegistryEntry = {
      backend: "d1",
      scope: "environment",
      rotatable: true,
      valueType: "text",
      origin: { kind: "helped", issuer: "cloudflare", needs: { cloudflare: ["com.cloudflare.api.account"] } },
      rotation: { kind: "provider", issuer: "cloudflare" },
      rotator,
      rotateEveryDays: 30,
      overlap: { days: 1, minimumDays: 1 },
    };
    const writes: string[] = [];
    const { deps, events, rows } = harness({
      entry: provider,
      store: {
        append: async (_name, value) => {
          writes.push(value);
          throw new Error("store unavailable");
        },
        retire: async () => {
          throw new Error("never reached");
        },
        versions: async () => undefined,
        fingerprints: async () => undefined,
      },
    });
    const { steps } = platformSteps(5);
    const result = await runValueRotation(deps, steps);

    expect(calls).toEqual(["roll"]);
    // The store is retried, in the same step, against the one value the roll returned.
    expect(writes.length).toBe(3);
    expect(new Set(writes).size).toBe(1);
    expect(result).toEqual({ status: "unrecorded", retired: [], held: [] });
    expect(rows[0]?.closed).toEqual({ status: "failed", reason: "not-recorded" });
    expect(events[0]).toMatchObject({ action: "secrets/rotated", outcome: "failure", severity: "critical" });
  });

  test("retirement waits for every value sealed under the secret, checking once a day", async () => {
    let checks = 0;
    const { deps, held } = harness({
      pending: async (dependents) => {
        checks += 1;
        return checks < 3 ? [...dependents] : [];
      },
    });
    const { steps, log } = platformSteps();
    const result = await runValueRotation(deps, steps);

    expect(result.retired).toEqual(["1"]);
    expect(log.filter((entry) => entry.name.startsWith("reencrypt-wait-")).map((entry) => entry.ms)).toEqual([
      REENCRYPTION_WAIT_MS,
      REENCRYPTION_WAIT_MS,
    ]);
    expect(Object.keys(held.get("auth-session-secret")?.versions ?? {})).toEqual(["2"]);
  });

  test("a dependent that never re-encrypts holds the old version, and says so", async () => {
    const { deps, held, holds, events } = harness({ pending: async (dependents) => [...dependents] });
    const { steps, log } = platformSteps();
    const result = await runValueRotation(deps, steps);

    expect(result).toEqual({ status: "rotated", version: "2", retired: [], held: ["auth-jwks"] });
    expect(log.filter((entry) => entry.name.startsWith("reencrypted-")).length).toBe(REENCRYPTION_CHECKS);
    // Nothing sealed under version 1 is stranded: it is still there.
    expect(Object.keys(held.get("auth-session-secret")?.versions ?? {})).toEqual(["1", "2"]);
    expect(holds).toEqual(["auth-session-secret"]);
    expect(events.at(-1)).toMatchObject({
      action: "secrets/version_retired",
      outcome: "failure",
      severity: "warning",
      metadata: { name: "auth-session-secret", pending: ["auth-jwks"] },
    });
  });

  test("the audit trail names the rotation and never its value", async () => {
    const { deps, events, held } = harness();
    const { steps } = platformSteps();
    await runValueRotation(deps, steps);
    const successor = held.get("auth-session-secret")?.versions["2"] as string;
    expect(events.map((event) => [event.action, event.outcome])).toEqual([
      ["secrets/rotated", "success"],
      ["secrets/version_retired", "success"],
    ]);
    expect(events[0]).toMatchObject({
      actorType: "system",
      resourceType: "secret",
      resourceId: "auth-session-secret",
      metadata: { trigger: "cron", status: "rotated", version: "2", environments: ["prod"] },
    });
    expect(JSON.stringify(events)).not.toContain(successor);
  });

  test("nothing it journals carries the value", async () => {
    const { deps, held } = harness();
    const journal: unknown[] = [];
    const { steps } = platformSteps();
    await runValueRotation(deps, {
      async do(name, fn, options) {
        const result = await steps.do(name, fn, options);
        journal.push(result);
        return result;
      },
      sleep: steps.sleep,
    });
    const successor = held.get("auth-session-secret")?.versions["2"] as string;
    expect(JSON.stringify(journal)).not.toContain(successor);
  });

  test("a secret declaring no overlap is refused before anything is called", async () => {
    const { overlap: _overlap, ...bare } = session;
    const { deps, held } = harness({ entry: bare });
    const { steps } = platformSteps();
    await expect(runValueRotation(deps, steps)).rejects.toThrow(/overlap/);
    expect(held.get("auth-session-secret")?.currentVersion).toBe("1");
  });
});
