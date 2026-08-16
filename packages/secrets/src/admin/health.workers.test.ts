// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { HealthSummaryKey } from "@pithy-sh/core/src/controlPlane/discovery/health";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { secrets } from "../capability";
import { secretsTables } from "../data/tables";
import { secretsAdminRoutes } from "../http/guards";
import { secrets_0001_init } from "../migrations/0001_init";
import { defineSecretRegistry } from "../registry";
import { SECRETS_DUE_FOR_ROTATION } from "./health";

/**
 * What `@pithy-sh/secrets` contributes to its manifest entry: how many secrets are past the cadence
 * their registry entry declares (#317).
 *
 * Against a real D1, because the number is the same two index-served reads the status surface makes and
 * the interesting cases are the ones with no row — a secret declared and never written, and one that has
 * never been rotated at all.
 */

const NOW = new Date("2026-08-11T00:00:00.000Z");
const CIPHERTEXT = "CIPHERTEXT-DO-NOT-LEAK";

function daysAgo(days: number): number {
  return NOW.getTime() - days * 86_400_000;
}

/** The project's registry: two secrets on a 90-day cadence, one with no cadence at all. */
const registry = defineSecretRegistry({
  "auth-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text", rotateEveryDays: 90 },
  "stripe-live-key": { backend: "d1", scope: "global", rotatable: false, valueType: "text", rotateEveryDays: 90 },
  "no-cadence": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
});

const capability = secrets({ registry });

async function storeSecret(name: string, createdAt: number): Promise<void> {
  await env.SECRETS.prepare(
    "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values (?, ?, 'IV', 1, 'text', ?, ?)",
  )
    .bind(name, CIPHERTEXT, createdAt, createdAt)
    .run();
}

async function recordRotation(name: string, completedAt: number, status = "success"): Promise<void> {
  await env.SECRETS.prepare(
    'insert into pithy_secrets_rotations (name, started_at, completed_at, status, "trigger", rotated_by) values (?, ?, ?, ?, ?, ?)',
  )
    .bind(name, completedAt, completedAt, status, "cron", "wf-1")
    .run();
}

/**
 * The producer, run through a real request so the `SECRETS` binding is resolved the way it is in a
 * deployed Worker rather than handed in by the test.
 */
async function summary(): Promise<Record<string, unknown>> {
  const health = capability.health;
  if (!health) throw new Error("the secrets capability contributes no health summary");
  const app = new Hono<PithyHonoEnv>();
  app.get("/summary", async (c) => c.json(await health.read(c)));
  const response = await app.request("http://worker.example/summary", { method: "GET" }, env);
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("the declaration", () => {
  test("is one count, and it states what it costs", () => {
    const keys = capability.health?.keys ?? [];
    expect(keys).toHaveLength(1);
    const key = HealthSummaryKey.parse(keys[0]);
    expect(key.key).toBe(SECRETS_DUE_FOR_ROTATION);
    expect(key.kind).toBe("count");
    // Two statements, both served by an index — `name` is unique on the secrets table and indexed on the
    // rotations table — and both bounded by how many secrets the registry declares, never by how many
    // rows an adopter has. That is what `indexed` claims, and it is why this may sit on a manifest read.
    expect(key.cost).toBe("indexed");
  });

  test("is behind the scope the capability's own status read is behind, and no new one", () => {
    // An adopter is offered the scopes read off `adminRoutes` at connect. A number behind anything else
    // could never be granted, so it would be withheld for ever with nothing to do about it.
    const gated = new Set(secretsAdminRoutes("/secrets").map((route) => route.scope));
    expect(gated.has(capability.health?.keys[0]?.scope ?? "")).toBe(true);
  });
});

describe("the count", () => {
  test("is zero when every declared secret is inside its cadence", async () => {
    await storeSecret("auth-signing-key", daysAgo(10));
    await storeSecret("stripe-live-key", daysAgo(10));
    // Zero, and reported as a number: a client renders "nothing to rotate", which is a different fact
    // from being told nothing at all.
    expect(await summary()).toEqual({ [SECRETS_DUE_FOR_ROTATION]: 0 });
  });

  test("counts a secret whose last successful rotation is older than its cadence", async () => {
    await storeSecret("auth-signing-key", daysAgo(400));
    await recordRotation("auth-signing-key", daysAgo(120));
    await storeSecret("stripe-live-key", daysAgo(400));
    await recordRotation("stripe-live-key", daysAgo(10));
    expect(await summary()).toEqual({ [SECRETS_DUE_FOR_ROTATION]: 1 });
  });

  test("counts one never rotated since it was written, which is the secret this exists for", async () => {
    await storeSecret("auth-signing-key", daysAgo(400));
    expect(await summary()).toEqual({ [SECRETS_DUE_FOR_ROTATION]: 1 });
  });

  test("a failed rotation does not make a secret fresh", async () => {
    await storeSecret("auth-signing-key", daysAgo(400));
    await recordRotation("auth-signing-key", daysAgo(1), "failed");
    expect(await summary()).toEqual({ [SECRETS_DUE_FOR_ROTATION]: 1 });
  });

  test("a secret with no declared cadence is never counted — nobody has said what late means", async () => {
    await storeSecret("no-cadence", daysAgo(4000));
    expect(await summary()).toEqual({ [SECRETS_DUE_FOR_ROTATION]: 0 });
  });

  test("a secret declared and never written is not counted, because there is nothing to measure from", async () => {
    expect(await summary()).toEqual({ [SECRETS_DUE_FOR_ROTATION]: 0 });
  });

  /**
   * `#387`'s third acceptance criterion, and the reason the issue exists rather than being covered by
   * `#350`.
   *
   * `#350` gave a capability's health a fourth state, so a producer that throws costs its own number and
   * not the manifest. That worked: one malformed row made this read throw, the secrets capability reported
   * `unavailable`, and its siblings were fine. **It made the blast radius survivable and did not make the
   * read correct.** The freshness of every *other* secret was knowable and went unreported, and the
   * manifest could not say which row was the problem — which the dashboard renders as "Could not answer."
   * against the whole capability.
   *
   * So the number comes back, and it counts what is knowable. The unreadable secret is not counted, for
   * the same reason one with no declared cadence is not: nobody can say whether it is late.
   */
  test("one malformed row costs its own secret, and the count is still a number", async () => {
    await storeSecret("auth-signing-key", daysAgo(400));
    await storeSecret("stripe-live-key", daysAgo(400));
    // Both are 400 days old on a 90-day cadence, so both are overdue and the count would be 2.
    await env.SECRETS.prepare(
      "update pithy_secrets_system_secrets set created_at = 'not-a-date' where name = 'auth-signing-key'",
    ).run();

    // A number, not a withheld key and not a throw. One, because the readable overdue secret is still
    // counted and the unreadable one is no longer assertable either way.
    expect(await summary()).toEqual({ [SECRETS_DUE_FOR_ROTATION]: 1 });
  });
});
