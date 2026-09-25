// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { type CapabilityHealthSource, readCapabilityHealth } from "@pithy-sh/core/src/controlPlane/discovery/health";
import { type CapabilityHealthReport, HealthSummaryKey } from "@pithy-sh/core/src/controlPlane/discovery/healthSummary";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { type SecretsCapability, secrets } from "../capability";
import { AT_REST_ROTATION_NAME } from "../data/secretRotations";
import { secretsTables } from "../data/tables";
import { SECRETS_STATUS_READ_SCOPE, secretsAdminRoutes } from "../http/guards";
import { secrets_0001_init } from "../migrations/0001_init";
import { defineSecretRegistry } from "../registry";
import { AtRestRotationOutcome, LAST_AT_REST_ROTATION, SECRETS_DUE_FOR_ROTATION } from "./health";

/**
 * What `@pithy-sh/secrets` contributes to its manifest entry, against a real D1 and a real master-key
 * binding: how many secrets are past the cadence their registry entry declares (#317), and how the last
 * whole-store at-rest key rotation ended (#647).
 *
 * The second key is why the binding matters. Its headline case is a store whose `SECRETS_ENCRYPTION_KEYS`
 * will not resolve — the state in which no rotation can even start, so the ledger keeps reporting the
 * last one that could, and the manifest says `succeeded` for a store whose secrets cannot be decrypted.
 * Only a real binding, removed on purpose, proves that is now named.
 *
 * **Everything goes through `readCapabilityHealth`**, not through `health.read` directly. That is the
 * layer `checked()` runs in, so a produced value the declaration does not name fails the read here the
 * way it would on a manifest — and the per-capability catch it wraps is what the `unreadable` case is
 * asserted against.
 */

/**
 * The clock every offset below is measured from — the runtime's own, not a frozen instant.
 *
 * Both keys are read through a real request, so neither takes a `now`: the count measures freshness from
 * `Date.now()` inside `readSecretStatus`, and `stale` measures the last pass's age from `Date.now()`
 * inside `readAtRestRotationOutcome`. A literal date here would be a fixed distance from the real clock
 * on the day it was written and a growing one every day after — so a row seeded "one day ago" would drift
 * past the staleness threshold and turn this suite red on a calendar boundary rather than on a change.
 * Relative offsets are what the assertions are actually about.
 */
const NOW = new Date();
const CIPHERTEXT = "CIPHERTEXT-DO-NOT-LEAK";

/** Anything a failure site could have pasted into a free-text column, in one greppable token. */
const KEY_MATERIAL = "MASTER-KEY-MATERIAL-DO-NOT-LEAK";

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

/**
 * The same project on a 7-day cadence, so the staleness threshold can be shown to come from
 * `secrets({ rotationIntervalDays })` rather than from a constant in the producer.
 */
const weeklyCapability = secrets({ registry, rotationIntervalDays: 7 });

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

/** One at-rest rotation row, with the free-text columns filled the way a real failure fills them. */
async function recordAtRestRotation(
  status: string,
  options: {
    trigger?: string;
    errorMessage?: string;
    metadataSnapshot?: string;
    startedAt?: number;
    /** Override the completion instant, including to `null` for a row this capability would never write. */
    completedAt?: number | null;
  } = {},
): Promise<void> {
  const startedAt = options.startedAt ?? daysAgo(1);
  await env.SECRETS.prepare(
    'insert into pithy_secrets_rotations (name, started_at, completed_at, status, "trigger", rotated_by, error_message, metadata_snapshot) values (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      AT_REST_ROTATION_NAME,
      startedAt,
      options.completedAt !== undefined ? options.completedAt : status === "in_progress" ? null : startedAt,
      status,
      options.trigger ?? "cron",
      "wf-at-rest",
      options.errorMessage ?? null,
      options.metadataSnapshot ?? null,
    )
    .run();
}

/** The capability's contribution, as the seam holds it between assembly and a request. */
function source(composed: SecretsCapability = capability): CapabilityHealthSource {
  const health = composed.health;
  if (!health) throw new Error("the secrets capability contributes no health summary");
  return { capability: "secrets", keys: health.keys, read: health.read };
}

/**
 * The producer, run through a real request and through the seam's own reader, so the binding is
 * resolved the way it is in a deployed Worker and `checked()` sits between the producer and the wire.
 */
async function report(
  bindings: Record<string, unknown> = {},
  composed: SecretsCapability = capability,
): Promise<CapabilityHealthReport> {
  const app = new Hono<PithyHonoEnv>();
  let produced: CapabilityHealthReport = { state: "undeclared" };
  app.get("/summary", async (c) => {
    produced = await readCapabilityHealth(source(composed), [SECRETS_STATUS_READ_SCOPE], (s) => s.read(c));
    return c.json({ ok: true });
  });
  await app.request("http://worker.example/summary", { method: "GET" }, { ...env, ...bindings });
  return produced;
}

/** The reported values, or a failure naming the state that came back instead. */
async function summary(
  bindings: Record<string, unknown> = {},
  composed: SecretsCapability = capability,
): Promise<Record<string, unknown>> {
  const produced = await report(bindings, composed);
  if (produced.state !== "reported") throw new Error(`the secrets summary came back ${produced.state}`);
  return produced.values;
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("the declaration", () => {
  test("is two keys: the count, and how the last at-rest rotation ended", () => {
    const keys = (capability.health?.keys ?? []).map((key) => HealthSummaryKey.parse(key));
    expect(keys.map((key) => key.key)).toEqual([SECRETS_DUE_FOR_ROTATION, LAST_AT_REST_ROTATION]);
    expect(keys.map((key) => key.kind)).toEqual(["count", "state"]);
  });

  test("both state what they cost, and neither costs a scan", () => {
    // Two registry-bounded statements for the count, plus one binding read and one reverse seek into
    // `pithySecretsRotationsNameIdx` that returns one row whatever the table holds. That is what
    // `indexed` claims, and it is why either may sit on a manifest read.
    for (const key of capability.health?.keys ?? []) expect(key.cost).toBe("indexed");
  });

  test("both are behind a scope the capability's own admin routes require, and no new one", () => {
    // An adopter is offered the scopes read off `adminRoutes` at connect. A value behind anything else
    // could never be granted, so it would be withheld for ever with nothing to do about it.
    const gated = new Set(secretsAdminRoutes("/secrets").map((route) => route.scope));
    for (const key of capability.health?.keys ?? []) expect(gated.has(key.scope)).toBe(true);
  });
});

describe("the count", () => {
  test("is zero when every declared secret is inside its cadence", async () => {
    await storeSecret("auth-signing-key", daysAgo(10));
    await storeSecret("stripe-live-key", daysAgo(10));
    // Zero, and reported as a number: a client renders "nothing to rotate", which is a different fact
    // from being told nothing at all.
    expect((await summary())[SECRETS_DUE_FOR_ROTATION]).toBe(0);
  });

  test("counts a secret whose last successful rotation is older than its cadence", async () => {
    await storeSecret("auth-signing-key", daysAgo(400));
    await recordRotation("auth-signing-key", daysAgo(120));
    await storeSecret("stripe-live-key", daysAgo(400));
    await recordRotation("stripe-live-key", daysAgo(10));
    expect((await summary())[SECRETS_DUE_FOR_ROTATION]).toBe(1);
  });

  test("counts one never rotated since it was written, which is the secret this exists for", async () => {
    await storeSecret("auth-signing-key", daysAgo(400));
    expect((await summary())[SECRETS_DUE_FOR_ROTATION]).toBe(1);
  });

  test("a failed rotation does not make a secret fresh", async () => {
    await storeSecret("auth-signing-key", daysAgo(400));
    await recordRotation("auth-signing-key", daysAgo(1), "failed");
    expect((await summary())[SECRETS_DUE_FOR_ROTATION]).toBe(1);
  });

  test("a secret with no declared cadence is never counted — nobody has said what late means", async () => {
    await storeSecret("no-cadence", daysAgo(4000));
    expect((await summary())[SECRETS_DUE_FOR_ROTATION]).toBe(0);
  });

  test("a secret declared and never written is not counted, because there is nothing to measure from", async () => {
    expect((await summary())[SECRETS_DUE_FOR_ROTATION]).toBe(0);
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
    expect((await summary())[SECRETS_DUE_FOR_ROTATION]).toBe(1);
  });
});

describe("the last at-rest rotation", () => {
  test("is `neverRun` on a store where none has ever been recorded, and never `succeeded`", async () => {
    expect(await summary()).toEqual({
      [SECRETS_DUE_FOR_ROTATION]: 0,
      [LAST_AT_REST_ROTATION]: "neverRun",
    });
  });

  test("is `succeeded` after one that finished", async () => {
    await recordAtRestRotation("success");
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("succeeded");
  });

  test("is `inProgress` while a pass is open — an interrupted Workflow leaves this, and it is not nominal", async () => {
    await recordAtRestRotation("in_progress");
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("inProgress");
  });

  /**
   * #647's own acceptance criterion, in one test.
   *
   * A rotation that aborts safely damages nothing, marks its row `failed`, and rethrows into a cron
   * nobody watches. Every declared secret here is inside its cadence, so the count says 0 — exactly the
   * reading that hid this for up to `ROTATION_INTERVAL_DAYS` — and the second key says it on the next
   * manifest read.
   */
  test("an aborted rotation is visible immediately, while the count still reads zero", async () => {
    await storeSecret("auth-signing-key", daysAgo(10));
    await recordAtRestRotation("failed");
    expect(await summary()).toEqual({
      [SECRETS_DUE_FOR_ROTATION]: 0,
      [LAST_AT_REST_ROTATION]: "failed",
    });
  });

  test("reports the newest attempt, so a failure after a success is not hidden by it", async () => {
    await recordAtRestRotation("success", { startedAt: daysAgo(30) });
    await recordAtRestRotation("failed", { startedAt: daysAgo(1) });
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("failed");
  });

  /**
   * The newest *row*, not the latest journalled instant.
   *
   * `started_at` is the pass instant a Workflow step journals, so it is not monotonic across rows and
   * two rows can carry the same value. Insertion order is the ledger's own order and is what the
   * `(name, rowid)` index answers with one reverse seek — which is the whole of the `cost: "indexed"`
   * claim. Here the two orderings disagree on purpose: by `id` the answer is `failed`, by `started_at`
   * it would unambiguously be `succeeded`.
   */
  test("orders by row id, not by the journalled pass instant", async () => {
    await recordAtRestRotation("success", { startedAt: daysAgo(1) });
    await recordAtRestRotation("failed", { startedAt: daysAgo(90) });
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("failed");
  });

  test("another secret's failed rotation is not the at-rest one", async () => {
    await recordRotation("auth-signing-key", daysAgo(1), "failed");
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("neverRun");
  });

  /**
   * A baseline row is a first write, never a rotation.
   *
   * Nothing today reserves the sentinel against a registry that declares a secret of that name, and
   * `recordBaseline` writes a `success`/`baseline` row under whatever name it is given. Excluding the
   * trigger here means establishing such a secret cannot forge a `succeeded` on this key, and cannot
   * bury a real `failed` under it either.
   */
  test("a `baseline` row under the sentinel cannot forge a success", async () => {
    await recordAtRestRotation("failed", { startedAt: daysAgo(10) });
    await recordAtRestRotation("success", { trigger: "baseline", startedAt: daysAgo(1) });
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("failed");
  });

  /**
   * `#387`'s property, one level up.
   *
   * `readCapabilityHealth` catches per capability, not per key, so a throw on this read would report
   * `unavailable` for the whole entry and take the count with it. A ledger row that will not decode is a
   * fact about that row, and it costs its own key.
   */
  test("a row whose status will not decode costs its own key, and the count still answers", async () => {
    await storeSecret("auth-signing-key", daysAgo(400));
    await recordAtRestRotation("rotating");
    expect(await summary()).toEqual({
      [SECRETS_DUE_FOR_ROTATION]: 1,
      [LAST_AT_REST_ROTATION]: "unreadable",
    });
  });
});

/**
 * A cron that stopped firing — the other way this key could report `succeeded` about a store nobody is
 * rotating (#647).
 *
 * `masterKeyUnresolvable` covers a dead key. Nothing covered a dead schedule: remove the
 * `AT_REST_ROTATION` binding, drop the cron trigger from the manager's `wrangler.jsonc`, or stop
 * deploying the manager Worker, and every one of those leaves the newest ledger row saying `success`
 * with nothing ever writing another. The ledger cannot tell the difference between a rotation that is
 * working and a rotation that stopped a year ago; the row's age can, measured against the cadence the
 * project itself declared.
 */
describe("a rotation that stopped running", () => {
  test("reports `stale` two cadences on, while the count still reads zero", async () => {
    // Exactly the reading that hid this. Every declared secret is inside its own 90-day cadence, so the
    // count is 0 and grades nominal — and before `stale` the second key said `succeeded`, so the whole
    // capability rendered healthy for a store whose master key had not moved in two months.
    await storeSecret("auth-signing-key", daysAgo(10));
    await recordAtRestRotation("success", { startedAt: daysAgo(61) });
    expect(await summary()).toEqual({
      [SECRETS_DUE_FOR_ROTATION]: 0,
      [LAST_AT_REST_ROTATION]: "stale",
    });
  });

  test("would have read `succeeded` — the same store, the same row, one day younger than the threshold", async () => {
    // The control. Without it the test above proves only that *something* differs, not that the store
    // it describes used to report the comfortable answer.
    await storeSecret("auth-signing-key", daysAgo(10));
    await recordAtRestRotation("success", { startedAt: daysAgo(59) });
    expect(await summary()).toEqual({
      [SECRETS_DUE_FOR_ROTATION]: 0,
      [LAST_AT_REST_ROTATION]: "succeeded",
    });
  });

  test("a pass that is merely due is still `succeeded`, so the key is not noise every cadence", async () => {
    // 31 days on a 30-day cadence: due, and the next tick has not finished yet. A project in this state
    // is healthy, and a key that flagged it would be muted long before a real dead cron arrived.
    await recordAtRestRotation("success", { startedAt: daysAgo(31) });
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("succeeded");
  });

  /**
   * The threshold is the adopter's cadence, threaded from `pithy.config.ts` through `capability.ts`.
   *
   * One row, two projects, two answers. A 30-day project calls a 31-day-old pass fresh; a 7-day project
   * calls the same row stale, because four of its cadences have passed. This fails if the interval is
   * ever hard-coded in the producer rather than taken from `secrets({ rotationIntervalDays })`.
   */
  test("is graded against the interval this project configured, not a fixed number of days", async () => {
    await recordAtRestRotation("success", { startedAt: daysAgo(31) });
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("succeeded");
    expect((await summary({}, weeklyCapability))[LAST_AT_REST_ROTATION]).toBe("stale");
  });

  test("a store that never rotated is still `neverRun`, never `stale`", async () => {
    // Two different conversations with an operator: one project has never started rotating, the other
    // rotated and then stopped. Collapsing them would lose the one an adopter can act on immediately.
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("neverRun");
  });

  test("an old failure keeps its own member — the more actionable fact travels", async () => {
    await recordAtRestRotation("failed", { startedAt: daysAgo(400) });
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("failed");
  });

  test("a `success` row with no completion instant is `unreadable`, never `succeeded`", async () => {
    // `markSuccess` writes the status and the instant in one statement, so this row did not come from
    // this capability. Its age cannot be established, and the one answer it must not produce is the
    // nominal one.
    await recordAtRestRotation("success", { completedAt: null });
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("unreadable");
  });

  test("a completion instant that will not decode is `unreadable` too, and costs only its own key", async () => {
    await storeSecret("auth-signing-key", daysAgo(400));
    await recordAtRestRotation("success");
    await env.SECRETS.prepare(
      `update pithy_secrets_rotations set completed_at = 'not-a-date' where name = '${AT_REST_ROTATION_NAME}'`,
    ).run();
    expect(await summary()).toEqual({
      [SECRETS_DUE_FOR_ROTATION]: 1,
      [LAST_AT_REST_ROTATION]: "unreadable",
    });
  });

  test("an unresolvable master key still wins over a stale pass", async () => {
    // Precedence, end to end. A store that cannot open its own key has no meaningful last rotation to
    // age, and the more actionable of the two facts is the one that travels.
    await recordAtRestRotation("success", { startedAt: daysAgo(400) });
    expect((await summary({ SECRETS_ENCRYPTION_KEYS: undefined }))[LAST_AT_REST_ROTATION]).toBe(
      "masterKeyUnresolvable",
    );
  });
});

/**
 * D15 — the headline case, and the reason this key is not simply the ledger's last row.
 *
 * `resolveEncryptionConfig` runs before the rotation opens a ledger row, in both `manager/worker.ts`'s
 * `scheduled()` and `manager/rotationWorkflow.ts`. When the master key will not resolve it throws there,
 * so no row is ever written and the ledger's last word stays whatever the previous pass said. Each test
 * below seeds a genuine `success` row first, so the assertion is exactly the one #647 exists for: the
 * store that would have reported `succeeded` now names the state it is actually in.
 */
describe("a master key that will not resolve", () => {
  beforeEach(async () => {
    await recordAtRestRotation("success");
  });

  test("is reported as its own member rather than as the last pass that could run", async () => {
    expect((await summary({ SECRETS_ENCRYPTION_KEYS: undefined }))[LAST_AT_REST_ROTATION]).toBe(
      "masterKeyUnresolvable",
    );
  });

  test("would otherwise read `succeeded` — the same store, with the binding intact", async () => {
    // The control. Without it the test above proves only that *something* differs, not that the ledger
    // says the comfortable thing.
    expect((await summary())[LAST_AT_REST_ROTATION]).toBe("succeeded");
  });

  test("a binding that will not parse is the same fact, and reports the same member", async () => {
    expect((await summary({ SECRETS_ENCRYPTION_KEYS: "not-a-config" }))[LAST_AT_REST_ROTATION]).toBe(
      "masterKeyUnresolvable",
    );
  });

  test("costs its own key: the count is still answered from a database that is fine", async () => {
    await storeSecret("auth-signing-key", daysAgo(400));
    expect(await summary({ SECRETS_ENCRYPTION_KEYS: undefined })).toEqual({
      [SECRETS_DUE_FOR_ROTATION]: 1,
      [LAST_AT_REST_ROTATION]: "masterKeyUnresolvable",
    });
  });
});

/**
 * An outcome, and never a reason (#386).
 *
 * Two assertions, because they fail to different edits. The first is about the wire: nothing from the
 * row's free text, and not the sentinel name either, appears in what a management client receives. The
 * second is about the query: those columns are never selected, so no later projection can reach them
 * whatever it does with the row it is handed.
 */
describe("what the key may carry", () => {
  test("no text from a failed row reaches the wire", async () => {
    await recordAtRestRotation("failed", {
      errorMessage: `decrypt failed for ${KEY_MATERIAL}`,
      metadataSnapshot: JSON.stringify({ versions: { 4: KEY_MATERIAL } }),
    });
    const values = await summary();
    expect(values[LAST_AT_REST_ROTATION]).toBe("failed");
    const wire = JSON.stringify(values);
    expect(wire).not.toContain(KEY_MATERIAL);
    expect(wire).not.toContain("decrypt failed");
    // The sentinel is an internal address, not a fact about anybody's posture, and it is the one string
    // a "helpful" value would most plausibly be built from.
    expect(wire).not.toContain(AT_REST_ROTATION_NAME);
  });

  test("the rotations table is never asked for its free-text columns at all", async () => {
    await recordAtRestRotation("failed", { errorMessage: KEY_MATERIAL, metadataSnapshot: KEY_MATERIAL });
    const issued: string[] = [];
    const recorder = {
      prepare(query: string) {
        issued.push(query);
        return env.SECRETS.prepare(query);
      },
    } as unknown as D1Database;

    expect((await summary({ SECRETS: recorder }))[LAST_AT_REST_ROTATION]).toBe("failed");

    const againstRotations = issued.filter((query) => query.includes("pithy_secrets_rotations"));
    // Without this the assertion below passes on an empty list, which is the shape of a leak check that
    // cannot fail.
    expect(againstRotations.length).toBeGreaterThan(0);
    for (const query of againstRotations) {
      expect(query).not.toContain("error_message");
      expect(query).not.toContain("metadata_snapshot");
    }
  });

  test("every value the producer can send is one the declaration names", async () => {
    // `checked()` runs inside `readCapabilityHealth` and refuses a value outside the declared `states`,
    // reporting `unavailable` instead. So a row whose status is garbage reaching the wire as itself
    // would fail here as a missing report rather than as a wrong string.
    await recordAtRestRotation("rotating", { errorMessage: KEY_MATERIAL });
    const produced = await report();
    expect(produced.state).toBe("reported");
    expect(AtRestRotationOutcome.options).toContain(
      (produced.state === "reported" ? produced.values[LAST_AT_REST_ROTATION] : undefined) as string,
    );
  });
});
