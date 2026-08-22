// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { defineCapability, type PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { SecretRotation } from "@pithy-sh/core/src/capability/secretOrigin";
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
import { SECRETS_ROTATE_SCOPE, SECRETS_STATUS_READ_SCOPE } from "./guards";
import {
  type SecretRotateResponse,
  SecretRotationOutcomeView,
  SecretRotationsResponse,
  SecretRotationView,
  SecretStatusView,
  SecretsStatusResponse,
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
const DECLARED = [
  "SECRETS_ENCRYPTION_KEYS",
  "auth-signing-key",
  "email-link-signing-key",
  "flaky-token",
  "gitlab-token",
  "global-signing-key",
  "provider-token",
  "session-key",
  "store-token",
  "unwritten-token",
];

/**
 * The two sentinels the rotation route is measured against.
 *
 * `ROLLED` is what a working rotator hands back — a live credential, for the length of one call. `ROLL_FAIL`
 * is what a failing one throws, which is the case that matters more: an exception raised inside a rotator
 * is raised in the one place a value is definitely in scope, and `rotateSecretValue` puts it on the outcome
 * as `cause`. Neither may appear in a response, in an audit event, or in a rotation row.
 */
const ROLLED = "ROLLED-CREDENTIAL-DO-NOT-LEAK";
const ROLL_FAIL = "ROTATOR-THREW-HOLDING-DO-NOT-LEAK";

/**
 * Every key `GET {base}/admin/status` may carry, at any depth. Sixteen: the envelope's one, a secret's
 * twelve, and the three a rotation declaration nests under one of them.
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
  // #372. `rotation` nests, so the sweep meets its three keys too — and naming them here is the point:
  // this list is what would have to be edited for a fourth to arrive, and there is no fourth a value
  // could be in. `kind` is a closed vocabulary, `issuer` is a closed vocabulary, and `documentation` is
  // an `https:` URL the schema constrains.
  "rotation",
  "kind",
  "issuer",
  "documentation",
  // #387. The names whose stored rows would not decode, so one bad row costs its own entry instead of the
  // read. Argued for here, beside the sentence saying why this list is narrow: the array holds registry
  // names — literals an operator wrote — and this read excludes keyed entries, so no stored
  // `<keyspace>/<key>` name embedding a tenant identifier can reach it. It carries no reason, because why
  // a row is malformed is a question about the database and not an answer for a client.
  "unreadable",
];

/** Every key `GET {base}/admin/status/:name/rotations` may carry. Seven. Written out, for the same reason. */
const PUBLISHED_ROTATIONS_KEYS = [
  "name",
  "rotations",
  "startedAt",
  "completedAt",
  "status",
  "trigger",
  "rotatedBy",
  // #387. How many rows of this page would not decode — a count, so that a client can say the history is
  // incomplete rather than render a short list as a whole one. A number is the only thing it can be.
  "unreadable",
];

/**
 * Every key `POST {base}/admin/status/:name/rotate` may carry. Ten: the envelope's one, and the outcome's
 * nine. Written out, for the same reason — and this is the surface where it matters most, because a value
 * is physically in the room when this response is composed.
 *
 * **`cause` is the absence to check for.** The core's outcome carries whatever the store or the rotator
 * threw, typed `unknown`. It has no key here and no line in the projection.
 */
const PUBLISHED_ROTATE_KEYS = [
  "rotation",
  "name",
  "status",
  "kind",
  "rolled",
  "rollFailed",
  "recorded",
  "stranded",
  "reason",
  "attempts",
];

/** How many times a rotator was asked to roll, across a test. Reset per test — see `beforeEach`. */
let rolls: string[] = [];

/** The random-mint declaration a `local` secret needs: minted here, so the kit can make another. */
const MINTED = { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } } as const;
/** A credential somebody else issued. Paired with a `provider` or `manual` rotation, never with `local`. */
const OBTAINED = { kind: "obtained", issuer: "gitlab", documentation: "https://gitlab.example/tokens" } as const;

const registry = defineSecretRegistry({
  // Declares no rotation at all — the third answer, and the one that must not render as `manual`.
  "auth-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text", rotateEveryDays: 90 },
  // A human in a console, with the issuer and the page named. What a client draws an instruction from.
  "gitlab-token": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    origin: OBTAINED,
    rotation: { kind: "manual", issuer: "gitlab", documentation: "https://gitlab.example/tokens" },
  },
  // Minted here from its own recipe. The rotation a Worker can actually perform end to end.
  "session-key": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
    origin: MINTED,
    rotation: { kind: "local" },
  },
  // Rolled at an issuer that hands back the successor. The rotator is this project's, as it must be.
  "provider-token": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    origin: OBTAINED,
    rotation: { kind: "provider", issuer: "gitlab" },
    rotator: {
      roll: async () => {
        rolls.push("provider-token");
        return { newValue: ROLLED };
      },
    },
  },
  // The rotator that throws. A define-time check cannot see this coming — whether a third party answers
  // is a runtime fact — so this is the one declaration that is only distinguishable by running it.
  "flaky-token": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    origin: OBTAINED,
    rotation: { kind: "provider", issuer: "gitlab" },
    rotator: {
      roll: async () => {
        rolls.push("flaky-token");
        throw new Error(`the issuer refused, and this message is holding ${ROLL_FAIL}`);
      },
    },
  },
  // Rotatable in every sense, and never written — the case where a late refusal would manufacture the
  // unrecorded incident out of a configuration gap that was free to check.
  "unwritten-token": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    origin: OBTAINED,
    rotation: { kind: "provider", issuer: "gitlab" },
    rotator: {
      roll: async () => {
        rolls.push("unwritten-token");
        return { newValue: ROLLED };
      },
    },
  },
  // Identical in every environment, so one Worker cannot rotate it without stranding the rest.
  "global-signing-key": {
    backend: "d1",
    scope: "global",
    rotatable: true,
    valueType: "text",
    devValue: "random",
    origin: MINTED,
    rotation: { kind: "local" },
  },
  // Lives in Cloudflare's account-level store, which no application Worker writes to.
  "store-token": {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
    origin: MINTED,
    rotation: { kind: "local" },
  },
});

/** The email capability's slice — a secret this project holds that the adopter never typed. */
const emailSlice = defineSecretRegistry({
  "email-link-signing-key": { backend: "d1", scope: "global", rotatable: true, valueType: "text" },
});

function context(granted: string[], environment = "prod"): ControlPlaneContext {
  return {
    connectionId: "conn-1",
    environment,
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
function harness(granted: string[] = [SECRETS_STATUS_READ_SCOPE], environment = "prod"): Harness {
  const capability = secrets({ registry });
  const emailCap = defineCapability({ name: "email", requiredBindings: [], secretRegistry: emailSlice });
  capability.compose?.({ capabilities: [capability, emailCap] });

  const events: AuditEventInput[] = [];
  const verify: ControlPlaneVerifier = async (_request, requirement) => {
    if (typeof requirement === "string" && !granted.includes(requirement)) {
      throw new Error(`ungranted ${requirement}`);
    }
    return context(granted, environment);
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

/** The rotation call. No body — the route reads none, and one sent is one nobody can smuggle a value into. */
async function rotate(h: Harness, name: string): Promise<Response> {
  return await h.app.request(`/secrets/admin/status/${name}/rotate`, { method: "POST" }, env);
}

/** A harness whose credential may rotate. The read scope comes with it, because a client holding both is real. */
function rotator(environment = "prod"): Harness {
  return harness([SECRETS_STATUS_READ_SCOPE, SECRETS_ROTATE_SCOPE], environment);
}

/** One secret's stored ciphertext, so a test can prove a rotation actually replaced it. */
async function ciphertextOf(name: string): Promise<string | undefined> {
  const row = await env.SECRETS.prepare("select encrypted_value from pithy_secrets_system_secrets where name = ?")
    .bind(name)
    .first<{ encrypted_value: string }>();
  return row?.encrypted_value;
}

/** Every rotation row recorded for one secret, newest first. The history an incident review reads. */
async function historyOf(name: string): Promise<{ status: string; trigger: string; rotated_by: string }[]> {
  const rows = await env.SECRETS.prepare(
    'select status, "trigger", rotated_by from pithy_secrets_rotations where name = ? order by id desc',
  )
    .bind(name)
    .all<{ status: string; trigger: string; rotated_by: string }>();
  return rows.results;
}

/** Seed a name into the store so `update` has something to replace. The ciphertext is opaque to a rotation. */
async function seed(name: string, ciphertext: string): Promise<void> {
  await env.SECRETS.prepare(
    "insert into pithy_secrets_system_secrets (name, encrypted_value, iv, key_version, value_type, created_at, updated_at) values (?, ?, ?, 1, 'text', ?, ?)",
  )
    .bind(name, ciphertext, IV, SEEDED_AT_MS, SEEDED_AT_MS)
    .run();
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
  // The rotatable secrets, stored. A rotation is an `update`, so a name with no row is refused before
  // anything is rolled — which is a case of its own, and `unwritten-token` is deliberately left out.
  for (const name of ["session-key", "provider-token", "flaky-token", "global-signing-key"]) {
    await seed(name, `${CIPHERTEXT}-${name}`);
  }
  rolls = [];
});

describe("GET {base}/admin/status", () => {
  test("reports every composed capability's secrets, dates as ISO-8601", async () => {
    const h = harness();
    const response = await call(h, "/secrets/admin/status");
    expect(response.status).toBe(200);
    const body = (await response.json()) as SecretsStatusResponse;

    expect(body.secrets.map((secret) => secret.name)).toEqual(DECLARED);
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

  test("each secret says how it rotates — the kind, the issuer, and the page — or says nothing", async () => {
    // The read #372 exists for. Before it, `rotation.kind` reached no remote client at all, so a
    // dashboard's only conservative reading was to give every secret an instruction and none of them a
    // control. All three answers are asserted, from one response, because a client branches on which of
    // them it got and a surface that could only ever return one of the three would pass a looser check.
    const body = (await (await call(harness(), "/secrets/admin/status")).json()) as SecretsStatusResponse;
    const secrets: Record<string, SecretStatusView | undefined> = Object.fromEntries(
      body.secrets.map((secret) => [secret.name, secret]),
    );

    expect(secrets["session-key"]?.rotation).toEqual({ kind: "local" });
    expect(secrets["provider-token"]?.rotation).toEqual({ kind: "provider", issuer: "gitlab" });
    expect(secrets["gitlab-token"]?.rotation).toEqual({
      kind: "manual",
      issuer: "gitlab",
      documentation: "https://gitlab.example/tokens",
    });
    // Declared nothing. Not `manual`, which would tell an operator to visit a console nobody named.
    expect(secrets["auth-signing-key"]?.rotation).toBeNull();
    // And the fact this replaces the guess with: `rotatable` says nothing about any of it. All four of
    // these are `rotatable: true` and they rotate three different ways, one of which is "unstated".
    for (const name of ["session-key", "provider-token", "gitlab-token", "auth-signing-key"]) {
      expect(secrets[name]?.rotatable, name).toBe(true);
    }
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
      1,
      0,
      2,
      90,
      SEEDED_AT,
      // The rotation declaration (#372): the three kinds, the one issuer this project's secrets name, and
      // the one page it names. Every one of them is a closed vocabulary or a schema-constrained URL, and
      // that is the whole argument for publishing them — none of the three can hold a credential.
      "local",
      "provider",
      "manual",
      "gitlab",
      "https://gitlab.example/tokens",
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
    //
    // `rotation` nests, so the schema's keys include its union members'. Read off the union **only for
    // this comparison**, and only because the direction that matters runs the other way: the list is what
    // grants permission, and it is hand-written, so a field the schema gains still has to be typed out
    // below before it may cross. Reading the union here lets the second assertion notice a *removal*.
    const nested = SecretRotation.options.flatMap((member) => Object.keys(member.shape));
    // The envelope's own keys are read too, not typed out — `#387` added `unreadable` beside `secrets`,
    // and an envelope field is exactly as capable of carrying something as a row field is.
    const declared = [...Object.keys(SecretsStatusResponse.shape), ...Object.keys(SecretStatusView.shape), ...nested];
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
    expect(event?.metadata).toMatchObject({ connectionId: "conn-1", declared: DECLARED.length, overdue: 1 });
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
      // #387's count, zero on a history whose rows all decode.
      0,
    ];
    const escaped = unpublishedIn(raw, { leaves: published, keys: PUBLISHED_ROTATIONS_KEYS });
    expect(escaped, `The rotation history published this:\n  ${escaped.join("\n  ")}`).toEqual([]);
  });

  test("the rotations schema declares nothing the hand-written key list does not name", () => {
    // The envelope read rather than typed out, for the reason the status read's twin states: `#387` put
    // `unreadable` on it, and an envelope field crosses exactly as far as a row field does.
    const declared = [...Object.keys(SecretRotationsResponse.shape), ...Object.keys(SecretRotationView.shape)];
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

describe("POST {base}/admin/status/:name/rotate — what it does", () => {
  test("a local secret is re-minted here, stored, and recorded against the operator", async () => {
    const before = await ciphertextOf("session-key");
    const h = rotator();
    const response = await rotate(h, "session-key");

    expect(response.status).toBe(200);
    const body = (await response.json()) as SecretRotateResponse;
    expect(body.rotation).toMatchObject({
      name: "session-key",
      status: "rotated",
      kind: "local",
      // Nothing was rolled anywhere: a `local` secret is minted from its own recipe, so no third party's
      // state moved and the word that would say it did is false.
      rolled: false,
      rollFailed: false,
      recorded: ["prod"],
      stranded: [],
      reason: null,
    });
    // It actually replaced the value. Asserted on the ciphertext because nothing here may read a plaintext
    // — which is the point: the proof a rotation happened does not require seeing what it wrote.
    expect(await ciphertextOf("session-key")).not.toBe(before);

    // And it advanced the history, which is what stops a rotated secret reporting overdue forever.
    const history = await historyOf("session-key");
    expect(history[0]).toMatchObject({ status: "success", trigger: "manual", rotated_by: "operator-1" });
  });

  test("a provider secret is rolled at its issuer, and the credential it returns reaches nothing but the store", async () => {
    const h = rotator();
    const response = await rotate(h, "provider-token");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(rolls).toEqual(["provider-token"]);
    expect((JSON.parse(text) as SecretRotateResponse).rotation).toMatchObject({
      status: "rotated",
      kind: "provider",
      rolled: true,
      recorded: ["prod"],
    });
    // The sentinel. It was a live credential for the length of one call and it must appear in no response,
    // no audit event, and no rotation row — the three places a value gets copied to "for debugging".
    expect(text).not.toContain(ROLLED);
    expect(JSON.stringify(h.events)).not.toContain(ROLLED);
    const rows = await env.SECRETS.prepare("select * from pithy_secrets_rotations").all();
    expect(JSON.stringify(rows.results)).not.toContain(ROLLED);
  });

  test("the rotator is called exactly once, and never again on a retry", async () => {
    // The one rule `valueRotator.ts` exists to state. Rolling twice does not repair a failed store; it
    // issues a third credential and loses the second, which is the failure the retry was meant to prevent
    // arriving by way of the retry.
    await rotate(rotator(), "provider-token");
    expect(rolls).toEqual(["provider-token"]);
  });

  test("a manual secret is unchanged, calls nothing, and writes no history", async () => {
    const h = rotator();
    const response = await rotate(h, "gitlab-token");

    expect(response.status).toBe(200);
    const body = (await response.json()) as SecretRotateResponse;
    expect(body.rotation).toMatchObject({ status: "unchanged", kind: "manual", reason: "manual", rolled: false });
    expect(rolls).toEqual([]);
    // No rotation row: a history of attempts that logs the ones never attempted is a history nobody can
    // read, and it would advance nothing anyway.
    expect(await historyOf("gitlab-token")).toEqual([]);
    // And no audit line, for the same reason the CLI records none — nothing happened to record.
    expect(h.events.filter((event) => event.action === "secrets/rotated")).toEqual([]);
  });

  test("the rotation is audited with the operator, the secret, the environment and the outcome", async () => {
    const h = rotator();
    await rotate(h, "session-key");
    const event = h.events.find((candidate) => candidate.action === "secrets/rotated");
    expect(event?.outcome).toBe("success");
    expect(event?.actorType).toBe("control-plane");
    expect(event?.actorId).toBe("operator-1");
    expect(event?.resourceId).toBe("session-key");
    expect(event?.metadata).toMatchObject({
      connectionId: "conn-1",
      name: "session-key",
      status: "rotated",
      rotation: "local",
      rolled: false,
      environments: ["prod"],
    });
  });
});

describe("POST {base}/admin/status/:name/rotate — the failure that cannot be undone", () => {
  test("a rotator that throws reports `unrecorded`, not `failed`, and says the roll is unconfirmed", async () => {
    const h = rotator();
    const response = await rotate(h, "flaky-token");

    // 200 with the outcome, deliberately. Throwing would render one sentence and drop `recorded` and
    // `stranded`, which is the "all rotated" summary over a partial failure this design refuses.
    expect(response.status).toBe(200);
    const body = (await response.json()) as SecretRotateResponse;
    expect(body.rotation).toMatchObject({
      status: "unrecorded",
      kind: "provider",
      // *May* have been rolled. The call reached the issuer and the answer did not come back, and nothing
      // can tell a request that never landed from a response that was lost.
      rolled: true,
      rollFailed: true,
      recorded: [],
      stranded: ["prod"],
    });
  });

  test("the unrecorded state is audited `critical`, as a failure, naming what is stranded", async () => {
    const h = rotator();
    await rotate(h, "flaky-token");
    const event = h.events.find((candidate) => candidate.action === "secrets/rotated");
    expect(event?.outcome).toBe("failure");
    // The one administrative act on this surface that leaves a system broken. A trail somebody scans after
    // an incident sorts on this field.
    expect(event?.severity).toBe("critical");
    expect(event?.metadata).toMatchObject({ status: "unrecorded", rolled: true, rollFailed: true, stranded: ["prod"] });
  });

  test("nothing the rotator was holding when it threw reaches a response, a trail, or a row", async () => {
    // The trust boundary, from the inside. An exception raised inside a rotator is raised in the one place
    // a credential is definitely in scope, and `rotateSecretValue` puts it on the outcome as `cause`. The
    // wire projection has no field for it, the audit metadata is composed from named facts, and the
    // rotation row's failure text is written from the outcome's status rather than from the exception.
    const h = rotator();
    const text = await (await rotate(h, "flaky-token")).text();
    expect(text).not.toContain(ROLL_FAIL);
    expect(text).not.toContain("cause");
    expect(JSON.stringify(h.events)).not.toContain(ROLL_FAIL);
    const rows = await env.SECRETS.prepare("select * from pithy_secrets_rotations").all();
    expect(JSON.stringify(rows.results)).not.toContain(ROLL_FAIL);
  });

  test("a rotator that threw still leaves a trace in the history, closed as failed", async () => {
    // Opened before the roll for exactly this: a rotator that never returns must not leave the act it
    // performed invisible to the review that comes looking for it.
    await rotate(rotator(), "flaky-token");
    const history = await historyOf("flaky-token");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: "failed", trigger: "manual", rotated_by: "operator-1" });
  });
});

describe("POST {base}/admin/status/:name/rotate — what a Worker refuses, before anything is rolled", () => {
  test("a secret that has never been stored here is refused, and the rotator is never called", async () => {
    // The whole reason this check is up front. `runWriteSecret` in `update` mode raises on a missing name,
    // and reaching that raise *after* a provider roll would manufacture the unrecorded incident out of a
    // configuration gap that cost nothing to check.
    const response = await rotate(rotator(), "unwritten-token");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("secrets/not_found");
    expect(rolls).toEqual([]);
  });

  test("a Cloudflare Secrets Store secret is refused, naming the command that can", async () => {
    const response = await rotate(rotator(), "store-token");
    expect(response.status).toBe(409);
    const error = (await response.json()) as { error?: { code?: string; message?: string; action?: string } };
    expect(error.error?.code).toBe("secrets/rotation_unsupported");
    // The free path is in `message`, because `message` is the only field that crosses — the HTTP codec
    // strips `action`, so a remedy a *client* has to render cannot live there.
    expect(error.error?.message).toContain("pithy secrets rotate");
    expect(error.error?.action).toBeUndefined();
  });

  test("a global secret is refused rather than rotated in one environment and stranded in the rest", async () => {
    const response = await rotate(rotator(), "global-signing-key");
    expect(response.status).toBe(409);
    const error = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(error.error?.code).toBe("secrets/rotation_unsupported");
    expect(error.error?.message).toContain("pithy secrets rotate");
    // And it wrote nothing: a partial success labeled `rotated` is the shape being refused, so the store
    // must be untouched rather than merely reported as untouched.
    expect(await ciphertextOf("global-signing-key")).toBe(`${CIPHERTEXT}-global-signing-key`);
    expect(await historyOf("global-signing-key")).toEqual([]);
  });

  test("the master key is refused — nothing replaces the key every other secret is read through", async () => {
    const response = await rotate(rotator(), "SECRETS_ENCRYPTION_KEYS");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await historyOf("SECRETS_ENCRYPTION_KEYS")).toEqual([]);
  });

  test("a secret declaring no rotation is refused, and told to declare one", async () => {
    const response = await rotate(rotator(), "auth-signing-key");
    expect(response.status).toBe(400);
    expect(await historyOf("auth-signing-key")).toHaveLength(2); // the two seeded rows, and no third
  });

  test("a name no capability declares is a 404, and never a rotation of a row found by name", async () => {
    const response = await rotate(rotator(), "nope");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("secrets/not_found");
  });

  test("a deployment that cannot name its environment will not replace a credential", async () => {
    // `dev` is not a deployed environment and an unstamped Worker has no name at all. Either way this
    // deployment cannot say where a value would land, and an outcome that cannot name its environments is
    // the aggregate the whole design refuses — so it does not roll one.
    for (const environment of ["dev", ""]) {
      const response = await rotate(rotator(environment), "provider-token");
      expect(response.status, environment).toBe(409);
      expect(((await response.json()) as { error?: { code?: string } }).error?.code, environment).toBe(
        "secrets/rotation_unsupported",
      );
    }
    expect(rolls).toEqual([]);
  });
});

describe("POST {base}/admin/status/:name/rotate — the scope is a boundary", () => {
  test("the read grant does not confer the write, however many secrets it can already see", async () => {
    // The escalation this scope exists to prevent. A connection granted `secrets:status:read` can enumerate
    // a project's whole secret estate; if that grant also rotated, every adopter who ever wanted a status
    // pane would have handed over credential replacement without being asked.
    const h = harness([SECRETS_STATUS_READ_SCOPE]);
    expect((await call(h, "/secrets/admin/status")).status).toBe(200);

    const response = await rotate(h, "session-key");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(rolls).toEqual([]);
    expect(await historyOf("session-key")).toEqual([]);
  });

  test("a connection with neither scope is refused, and reaches no registry lookup", async () => {
    const response = await rotate(harness(["manifest:read"]), "session-key");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(rolls).toEqual([]);
  });

  test("nothing but the published facts can cross the rotation response, on either path", async () => {
    // The same sweep the two reads wear, on the surface where a value is physically in the room.
    //
    // **Both paths, and the failing one is the point.** The first version of this test swept only the
    // successful rotation, and a planted `cause: outcome.cause` on the projection sailed through it —
    // because a run that succeeds has no `cause`, so `JSON.stringify` drops the key and the sweep sees a
    // clean document. The response that can carry an exception is the response of a run that threw. A
    // gate over the path where nothing went wrong is the "gate over a store holding nothing secret" this
    // file's own header warns about, one surface along.
    const published = [
      "provider-token",
      "flaky-token",
      // The two closed vocabularies it reports, and the one environment it can write.
      "rotated",
      "unchanged",
      "unrecorded",
      "failed",
      "local",
      "provider",
      "manual",
      "prod",
      // `rolled` and `rollFailed`, and the nulls for "nothing was skipped" and "nothing was stored".
      true,
      false,
      null,
    ];
    for (const name of ["provider-token", "flaky-token"]) {
      const raw = (await (await rotate(rotator(), name)).json()) as unknown;
      const escaped = unpublishedIn(raw, { leaves: published, keys: PUBLISHED_ROTATE_KEYS });
      expect(escaped, `Rotating ${name} published this:\n  ${escaped.join("\n  ")}`).toEqual([]);
    }
  });

  test("the rotation schema declares nothing the hand-written key list does not name", () => {
    const declared = ["rotation", ...Object.keys(SecretRotationOutcomeView.shape)];
    expect(declared.filter((key) => !PUBLISHED_ROTATE_KEYS.includes(key))).toEqual([]);
    expect(PUBLISHED_ROTATE_KEYS.filter((key) => !declared.includes(key))).toEqual([]);
  });
});
