// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { defineCapability, type PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import type { ControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { unpublishedIn } from "@pithy-sh/core/src/projection/published";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { secrets } from "../capability";
import { secretsTables } from "../data/tables";
import { secrets_0001_init } from "../migrations/0001_init";
import { defineSecretRegistry } from "../registry";
import { SECRETS_STATUS_READ_SCOPE } from "./guards";
import {
  type SecretRotationsResponse,
  SecretRotationView,
  SecretStatusView,
  type SecretsStatusResponse,
} from "./responses";

/**
 * The whole path a management client takes, in workerd against a real D1: the composed capability's own
 * router, the seam's gate satisfied by a stub verifier, the readers, the views, and the audit emit.
 *
 * The verifier is stubbed rather than the routes rewired, because what is under test is everything
 * *after* verification. Whether an EdDSA-signed call verifies is `@pithy-sh/core`'s, tested there;
 * whether a verified call with the wrong grant is refused is asserted here, because the refusal is what
 * makes the scope a boundary rather than a label.
 */

const CIPHERTEXT = "CIPHERTEXT-DO-NOT-LEAK";
const NOW = new Date("2026-08-11T00:00:00.000Z");

/**
 * The sentinel store, and why every column below is loaded rather than left at a plausible value.
 *
 * The gate over these two reads is {@link unpublishedIn} — *every leaf is a fact this surface publishes,
 * and every key is one written out by hand below* — and a gate over a store holding nothing secret
 * passes perfectly. So the one declared, stored secret carries its ciphertext and its IV, and its
 * rotations carry a metadata snapshot, a failure message and an operator id. Each is a real column on
 * `pithy_secrets_system_secrets` or `pithy_secrets_rotations`; none of them may cross either read.
 *
 * `SEEDED_AT_MS` is the numeric sentinel and the subtle one. The dates are published *as ISO-8601
 * strings*, so the ms-epoch integer sitting in SQLite is a forbidden value of a different JSON type
 * under the same fact — the shape a `lastRotatedAtMs` field added "for the client's convenience" would
 * take. There is no boolean sentinel because neither table has a boolean column; a new boolean field is
 * refused by the key half instead, which `@pithy-sh/core`'s own `published.test.ts` proves bites.
 */
const IV = "IV-DO-NOT-LEAK";
const SNAPSHOT = "SNAPSHOT-DO-NOT-LEAK";
const FAILURE_TEXT = "FAILURE-TEXT-DO-NOT-LEAK";
const ROTATED_BY = "OPERATOR-ID-DO-NOT-LEAK-FROM-STATUS";
const SEEDED_AT_MS = NOW.getTime() - 400 * 86_400_000;
const SEEDED_AT = new Date(SEEDED_AT_MS).toISOString();
const FAILED_AT_MS = NOW.getTime() - 3 * 86_400_000;
const FAILED_AT = new Date(FAILED_AT_MS).toISOString();

/** The names the composed registry declares. Every one of them is a published fact on both reads. */
const DECLARED = ["SECRETS_ENCRYPTION_KEYS", "auth-signing-key", "email-link-signing-key"];

/**
 * Every key `GET {base}/admin/status` may carry, at any depth. Twelve: the envelope's one, and a
 * secret's eleven.
 *
 * **Written out, never `Object.keys(SecretStatusView.shape)`.** A gate that reads its own subject cannot
 * fail when the subject changes: deriving this from the schema means the edit adding a field widens the
 * permission in the same commit, and the test whose whole job is to catch that passes. That is not
 * hypothetical — it is what the catalog read's first version did. Widening this response means editing
 * the line below, deliberately, beside the sentence saying why it is narrow.
 */
const PUBLISHED_STATUS_KEYS = [
  "secrets",
  "name",
  "backend",
  "valueType",
  "rotatable",
  "keyVersion",
  "createdAt",
  "updatedAt",
  "lastRotatedAt",
  "rotationCount",
  "rotateEveryDays",
  "overdue",
];

/** Every key `GET {base}/admin/status/:name/rotations` may carry. Seven. Written out, for the same reason. */
const PUBLISHED_ROTATIONS_KEYS = ["name", "rotations", "startedAt", "completedAt", "status", "trigger", "rotatedBy"];

const registry = defineSecretRegistry({
  "auth-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text", rotateEveryDays: 90 },
});

/** The email capability's slice — a secret this project holds that the adopter never typed. */
const emailSlice = defineSecretRegistry({
  "email-link-signing-key": { backend: "d1", scope: "global", rotatable: true, valueType: "text" },
});

function context(granted: string[]): ControlPlaneContext {
  return {
    connectionId: "conn-1",
    environment: "production",
    issuer: "https://dashboard.example",
    subject: "operator-1",
    scope: SECRETS_STATUS_READ_SCOPE,
    grantedScopes: granted,
    keyId: "key-1",
    tokenId: "jti-1",
  };
}

interface Harness {
  app: Hono<PithyHonoEnv>;
  events: AuditEventInput[];
}

/**
 * A Worker composing `secrets()` and `email`, with the seam's verifier stubbed. `compose` runs, which is
 * what makes the status surface report the combined registry rather than only the adopter's own slice.
 */
function harness(granted: string[] = [SECRETS_STATUS_READ_SCOPE]): Harness {
  const capability = secrets({ registry });
  const emailCap = defineCapability({ name: "email", requiredBindings: [], secretRegistry: emailSlice });
  capability.compose?.({ capabilities: [capability, emailCap] });

  const events: AuditEventInput[] = [];
  const verify: ControlPlaneVerifier = async (_request, requirement) => {
    if (typeof requirement === "string" && !granted.includes(requirement)) {
      throw new Error(`ungranted ${requirement}`);
    }
    return context(granted);
  };

  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", verify);
    c.set("emit", async (event) => {
      events.push(event);
    });
    c.set("log", noopLogger);
    await next();
  });
  capability.routes?.(app);
  return { app, events };
}

/** `c.env` in these calls is the Miniflare env, so the handlers reach the real `SECRETS` binding. */
async function call(h: Harness, path: string): Promise<Response> {
  return await h.app.request(path, { method: "GET" }, env);
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
  await env.SECRETS.prepare(
    "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values ('auth-signing-key', ?, ?, 3, 'text', ?, ?)",
  )
    .bind(CIPHERTEXT, IV, SEEDED_AT_MS, SEEDED_AT_MS)
    .run();
  await env.SECRETS.prepare(
    "insert into pithy_secrets_rotations (name, started_at, completed_at, status, \"trigger\", rotated_by, error_message, metadata_snapshot) values ('auth-signing-key', ?, ?, 'success', 'baseline', 'baseline', null, ?)",
  )
    .bind(SEEDED_AT_MS, SEEDED_AT_MS, JSON.stringify({ note: SNAPSHOT }))
    .run();
  // A failed attempt, because the two columns most likely to hold a pasted value are only ever written
  // on a failure: `error_message` is free text from an exception site, and `metadata_snapshot` is what
  // somebody took "for debugging". Neither read may publish either, and a store with only successful
  // rotations gives the gate nothing to refuse.
  await env.SECRETS.prepare(
    "insert into pithy_secrets_rotations (name, started_at, completed_at, status, \"trigger\", rotated_by, error_message, metadata_snapshot) values ('auth-signing-key', ?, ?, 'failed', 'cron', ?, ?, ?)",
  )
    .bind(FAILED_AT_MS, FAILED_AT_MS, ROTATED_BY, FAILURE_TEXT, JSON.stringify({ note: SNAPSHOT }))
    .run();
});

describe("GET {base}/admin/status", () => {
  test("reports every composed capability's secrets, dates as ISO-8601", async () => {
    const h = harness();
    const response = await call(h, "/secrets/admin/status");
    expect(response.status).toBe(200);
    const body = (await response.json()) as SecretsStatusResponse;

    expect(body.secrets.map((secret) => secret.name)).toEqual([
      "SECRETS_ENCRYPTION_KEYS",
      "auth-signing-key",
      "email-link-signing-key",
    ]);
    const signing = body.secrets.find((secret) => secret.name === "auth-signing-key");
    expect(signing?.keyVersion).toBe(3);
    expect(signing?.createdAt).toBe(new Date(NOW.getTime() - 400 * 86_400_000).toISOString());
    expect(signing?.lastRotatedAt).toBe(new Date(NOW.getTime() - 400 * 86_400_000).toISOString());
    expect(signing?.rotateEveryDays).toBe(90);
    expect(signing?.overdue).toBe(true);
    // The secret nobody has ever written has nothing to measure and says so, rather than passing.
    const link = body.secrets.find((secret) => secret.name === "email-link-signing-key");
    expect(link?.lastRotatedAt).toBeNull();
    expect(link?.overdue).toBeNull();
  });

  test("nothing but the published facts can cross it, whatever a field is called", async () => {
    // The invariant, stated rather than enumerated. This read was guarded by two `not.toContain` calls,
    // which is complete only against the two strings somebody thought of — and a projection widens by
    // gaining a *field*, which is exactly the event a value list cannot observe. Here every leaf must be
    // a fact this surface publishes and every key must be one named above, so a new field carrying
    // anything at all is refused, whatever it is called and whatever type it is.
    const raw = (await (await call(harness(), "/secrets/admin/status")).json()) as unknown;

    const published = [
      ...DECLARED,
      // The vocabularies of the two enums it reports, written out rather than read off the schemas.
      "d1",
      "cf-secrets-store",
      "text",
      "json",
      // `rotatable`, `overdue`, and every null this surface uses to say "the question has no answer".
      // These three are in every JSON document's vocabulary, so the key half is what polices them.
      true,
      false,
      null,
      // The measurements: the master-key version, the attempt counts, the declared cadence, and the one
      // timestamp the store holds — as an ISO-8601 string, never as the ms-epoch integer it is in SQLite.
      3,
      0,
      2,
      90,
      SEEDED_AT,
    ];
    const escaped = unpublishedIn(raw, { leaves: published, keys: PUBLISHED_STATUS_KEYS });
    expect(escaped, `The secrets status read published this:\n  ${escaped.join("\n  ")}`).toEqual([]);
  });

  test("the store really holds everything the sweep is meant to refuse", async () => {
    // A gate over nothing passes perfectly. The seeded store must genuinely carry a ciphertext, an IV, a
    // metadata snapshot, a failure message, an operator id and a raw ms-epoch, or the test above proves
    // nothing at all about this read.
    const secret = await env.SECRETS.prepare(
      "select encrypted_value, iv, created_at from pithy_secrets_system_secrets where name = 'auth-signing-key'",
    ).first<{ encrypted_value: string; iv: string; created_at: number }>();
    expect(secret?.encrypted_value).toBe(CIPHERTEXT);
    expect(secret?.iv).toBe(IV);
    expect(secret?.created_at).toBe(SEEDED_AT_MS);
    const failed = await env.SECRETS.prepare(
      "select error_message, metadata_snapshot, rotated_by from pithy_secrets_rotations where status = 'failed'",
    ).first<{ error_message: string; metadata_snapshot: string; rotated_by: string }>();
    expect(failed?.error_message).toBe(FAILURE_TEXT);
    expect(failed?.metadata_snapshot).toContain(SNAPSHOT);
    expect(failed?.rotated_by).toBe(ROTATED_BY);

    // And what is meant to cross does cross, so the sweep is not passing over an empty response.
    const text = await (await call(harness(), "/secrets/admin/status")).text();
    for (const name of DECLARED) expect(text, name).toContain(name);
    expect(text).toContain(SEEDED_AT);
  });

  test("the response schema declares nothing the hand-written key list does not name", () => {
    // The second place a widening fails, and the earlier one: it fails on the schema edit, before a view
    // has been written to fill the new field. The list polices the schema; the schema never polices itself.
    const declared = ["secrets", ...Object.keys(SecretStatusView.shape)];
    expect(declared.filter((key) => !PUBLISHED_STATUS_KEYS.includes(key))).toEqual([]);
    // And in the other direction, so a field removed from the schema leaves no permission behind it.
    expect(PUBLISHED_STATUS_KEYS.filter((key) => !declared.includes(key))).toEqual([]);
  });

  test("the read is audited, in counts and never in content", async () => {
    // The seam records that the call was allowed; this capability records what the call read. Both, and
    // the second is the one that says a credential enumerated somebody's secret estate.
    const h = harness();
    await call(h, "/secrets/admin/status");
    const event = h.events.find((candidate) => candidate.action === "secrets/status_read");
    expect(event).toBeDefined();
    expect(event?.actorType).toBe("control-plane");
    expect(event?.actorId).toBe("operator-1");
    expect(event?.metadata).toMatchObject({ connectionId: "conn-1", declared: 3, overdue: 1 });
    expect(JSON.stringify(event)).not.toContain(CIPHERTEXT);
  });

  test("a connection without the scope is refused, and the refusal is not a 200 with fewer rows", async () => {
    const response = await call(harness(["manifest:read"]), "/secrets/admin/status");
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("GET {base}/admin/status/:name/rotations", () => {
  test("returns one secret's history, newest first", async () => {
    const response = await call(harness(), "/secrets/admin/status/auth-signing-key/rotations");
    expect(response.status).toBe(200);
    const body = (await response.json()) as SecretRotationsResponse;
    expect(body.name).toBe("auth-signing-key");
    expect(body.rotations).toHaveLength(2);
    // Newest first, which needs two rows to mean anything: the failed cron attempt three days ago comes
    // before the baseline write four hundred days ago.
    expect(body.rotations.map((rotation) => rotation.trigger)).toEqual(["cron", "baseline"]);
    expect(Object.keys(body.rotations[0] ?? {}).sort()).toEqual([
      "completedAt",
      "rotatedBy",
      "startedAt",
      "status",
      "trigger",
    ]);
  });

  test("nothing but the published facts can cross it — a failure is a status, never a message", async () => {
    // The read where the two most dangerous columns live. `error_message` is free text written at an
    // exception site, which is precisely where a value gets interpolated by accident, and
    // `metadata_snapshot` is what somebody took "for debugging". Both sit on the failed row this history
    // returns, so the invariant here is doing real work rather than describing an empty table.
    const raw = (await (await call(harness(), "/secrets/admin/status/auth-signing-key/rotations")).json()) as unknown;

    const published = [
      "auth-signing-key",
      // The two enum vocabularies, and the one identity a rotation may name: who ran it.
      "in_progress",
      "success",
      "failed",
      "cron",
      "manual",
      "baseline",
      ROTATED_BY,
      // The timestamps, as ISO-8601. `null` is the completion of a rotation still running.
      SEEDED_AT,
      FAILED_AT,
      null,
    ];
    const escaped = unpublishedIn(raw, { leaves: published, keys: PUBLISHED_ROTATIONS_KEYS });
    expect(escaped, `The rotation history published this:\n  ${escaped.join("\n  ")}`).toEqual([]);
  });

  test("the rotations schema declares nothing the hand-written key list does not name", () => {
    const declared = ["name", "rotations", ...Object.keys(SecretRotationView.shape)];
    expect(declared.filter((key) => !PUBLISHED_ROTATIONS_KEYS.includes(key))).toEqual([]);
    expect(PUBLISHED_ROTATIONS_KEYS.filter((key) => !declared.includes(key))).toEqual([]);
  });

  test("a name no capability declares is a 404, not an empty history", async () => {
    // An empty history reads as "this secret has never been rotated", which is a fact about a secret
    // that does not exist. It would also make the route a listing of the rotations table by any name.
    const response = await call(harness(), "/secrets/admin/status/nope/rotations");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("secrets/not_found");
  });

  test("the whole-store key rotation cannot be addressed through this route", async () => {
    await env.SECRETS.prepare(
      "insert into pithy_secrets_rotations (name, started_at, completed_at, status, \"trigger\", rotated_by) values ('__at_rest_key_rotation__', 1, 1, 'success', 'cron', 'wf')",
    ).run();
    const response = await call(harness(), "/secrets/admin/status/__at_rest_key_rotation__/rotations");
    expect(response.status).toBe(404);
  });

  test("the read is audited against the secret it named", async () => {
    const h = harness();
    await call(h, "/secrets/admin/status/auth-signing-key/rotations");
    const event = h.events.find((candidate) => candidate.action === "secrets/rotations_read");
    expect(event?.resourceId).toBe("auth-signing-key");
    expect(event?.metadata).toMatchObject({ returned: 2 });
  });
});
