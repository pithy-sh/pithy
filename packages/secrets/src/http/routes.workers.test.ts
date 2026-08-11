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
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { secrets } from "../capability";
import { secretsTables } from "../data/tables";
import { secrets_0001_init } from "../migrations/0001_init";
import { defineSecretRegistry } from "../registry";
import { SECRETS_STATUS_READ_SCOPE } from "./guards";
import type { SecretRotationsResponse, SecretsStatusResponse } from "./responses";

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
    "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values ('auth-signing-key', ?, 'IV', 3, 'text', ?, ?)",
  )
    .bind(CIPHERTEXT, NOW.getTime() - 400 * 86_400_000, NOW.getTime() - 400 * 86_400_000)
    .run();
  await env.SECRETS.prepare(
    "insert into pithy_secrets_rotations (name, started_at, completed_at, status, \"trigger\", rotated_by, error_message, metadata_snapshot) values ('auth-signing-key', ?, ?, 'success', 'baseline', 'baseline', null, '{\"note\":\"SNAPSHOT-DO-NOT-LEAK\"}')",
  )
    .bind(NOW.getTime() - 400 * 86_400_000, NOW.getTime() - 400 * 86_400_000)
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

  test("no ciphertext or snapshot reaches the response body", async () => {
    const raw = await (await call(harness(), "/secrets/admin/status")).text();
    expect(raw).not.toContain(CIPHERTEXT);
    expect(raw).not.toContain("SNAPSHOT-DO-NOT-LEAK");
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
    expect(body.rotations).toHaveLength(1);
    expect(body.rotations[0]?.trigger).toBe("baseline");
    expect(Object.keys(body.rotations[0] ?? {}).sort()).toEqual([
      "completedAt",
      "rotatedBy",
      "startedAt",
      "status",
      "trigger",
    ]);
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
    expect(event?.metadata).toMatchObject({ returned: 1 });
  });
});
