// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { auth } from "@pithy-sh/auth/src/capability";
import { authSecretsRegistry } from "@pithy-sh/auth/src/instance/secrets";
import { AUTH_MIGRATION_ORDER } from "@pithy-sh/auth/src/migrations/0001_init";
import { AUTH_MIGRATIONS } from "@pithy-sh/auth/src/migrations/set";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { CONTROLPLANE_MIGRATION_ORDER, controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "@pithy-sh/core/src/controlPlane/data/tables";
import {
  ControlPlaneErasurePeriodResponse,
  ControlPlaneErasureSubjectResponse,
} from "@pithy-sh/core/src/controlPlane/http/responses";
import { controlplane_0001_init } from "@pithy-sh/core/src/controlPlane/migrations/0001_init";
import { controlplane_0002_management_origin } from "@pithy-sh/core/src/controlPlane/migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "@pithy-sh/core/src/controlPlane/migrations/0003_connection_principal";
import { type ControlPlaneScope, ERASURE_READ_SCOPE } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { EMAIL_MIGRATION_ORDER, email } from "@pithy-sh/email/src/capability";
import { emailSigningRegistry } from "@pithy-sh/email/src/crypto/signingKey";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { email_0001_suppressions } from "@pithy-sh/email/src/migrations/0001_suppressions";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OrganizationAuditActions } from "../audit/actions";
import { organization } from "../capability";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import { MEMBERSHIPS_TABLE, ORGANIZATIONS_TABLE, organizationDatabase } from "../data/tables";
import { ORGANIZATION_ACCOUNTS_DELETE_SCOPE } from "../http/scopes";
import { ORGANIZATION_MIGRATION_ORDER } from "../migrations/0001_init";
import { ORGANIZATION_MIGRATIONS } from "../migrations/set";
import { defineRoles } from "../roles/roles";
import { runOrganizationPurge } from "./workflow";

/**
 * An organization's erasure attested end to end (#823): a real `createBackend` composing auth, organization and the
 * control plane beside a recorder that cites each event by its place in the trail, an operator deleting an
 * organization through its own control-plane route, the purge Workflow's body erasing it, and the control plane's
 * two erasure reads answering for it. What `organization().erasureRecords` wires is proved here, through the route an
 * auditor calls, not through a stand-in.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "http://localhost";
const ENVIRONMENT = "dev";
const CONNECTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3399";
const ISSUER = "https://app.pithy.sh";
const KEY_ID = "cpk_admin_1";
const DAY = 86_400_000;

const REGISTRY = { ...authSecretsRegistry, ...emailSigningRegistry };
const SECRETS: SecretFixture<typeof REGISTRY> = {
  "auth-session-secret": "test-secret-please-rotate-0000000000",
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
  "email-link-signing-key": "dev-link-signing-key",
};

const TABLES = [
  "pithy_organization_lifecycle",
  "pithy_organization_acting",
  "pithy_organization_ownership_nominations",
  "pithy_organization_invitations",
  "pithy_organization_memberships",
  "pithy_organization_organizations",
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_user_lifecycle",
  "pithy_auth_verification_outcomes",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_email_jobs",
  "pithy_email_events",
  "pithy_email_suppressions",
  "pithy_controlplane_connections",
  "pithy_controlplane_replays",
  "pithy_migrations",
  "pithy_migrations_lock",
];

const roles = defineRoles({
  roles: {
    owner: ["organization:read", "organization:manage", "members:manage", "billing:manage", "organization:delete"],
  },
  administrativePower: "organization:manage",
});

let emitted: AuditEventInput[] = [];
let signingKey: CryptoKey;

/**
 * The recorder and citation reader `@pithy-sh/audit` declares, over one in-memory list: each event's place in the
 * list stands for its chain position, so every citation the attestation carries is checked against the trail.
 */
const recorderCapability = defineCapability({
  name: "recorder",
  requiredBindings: [],
  middleware: [
    (app) => {
      app.use("*", async (c, next) => {
        c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
        await next();
      });
    },
  ],
  auditRecorder: () => async (event) => void emitted.push(event as AuditEventInput),
  auditCitations: () => async (query) =>
    emitted.flatMap((event, index) =>
      event.resourceType === query.resourceType &&
      typeof event.resourceId === "string" &&
      query.resourceIds.includes(event.resourceId) &&
      query.actions.includes(event.action)
        ? [
            {
              eventId: `ev-${index + 1}`,
              action: event.action,
              resourceId: event.resourceId,
              occurredAt: new Date(),
              tenant: event.tenant ?? null,
              seq: index + 1,
              hash: "c".repeat(64),
              step: typeof event.metadata?.step === "string" ? event.metadata.step : null,
            },
          ]
        : [],
    ),
});

function memoryKv() {
  const entries = new Map<string, string>();
  return {
    get: async (name: string) => entries.get(name) ?? null,
    put: async (name: string, value: string) => void entries.set(name, value),
  };
}

function workerEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    ENVIRONMENT,
    EMAIL_SUPPRESSIONS: env.DB,
    EMAIL_SENDER: {},
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    CONTROL_PLANE: memoryKv(),
  };
}

function buildApp() {
  return createBackend({
    capabilities: [
      secrets({ registry: authSecretsRegistry }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: ORIGIN }),
      auth({ baseURL: ORIGIN, basePath: "/auth", trustedOrigins: [ORIGIN] }),
      organization({ roles, baseUrl: ORIGIN, sendInvitationEmail: false }),
      controlplane(),
      recorderCapability,
    ],
  });
}

async function grant(scopes: readonly ControlPlaneScope[]): Promise<void> {
  await env.DB.prepare("delete from pithy_controlplane_connections").run();
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  const now = new Date();
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(
      ControlPlaneConnection.encode({
        id: CONNECTION_ID,
        environment: ENVIRONMENT,
        issuer: ISSUER,
        workerUrl: "https://worker.example.test",
        basePath: "/control-plane",
        managementOrigin: null,
        authorizedBy: "ada@example.com",
        actorKind: "dashboard",
        purpose: "The hosted dashboard.",
        scopes: [...scopes],
        keys: [
          {
            keyId: KEY_ID,
            publicKey: await exportPublicJwk(pair.publicKey),
            validFrom: new Date(now.getTime() - 60_000),
            validUntil: null,
            revokedAt: null,
          },
        ],
        createdAt: now,
        updatedAt: now,
      }),
    )
    .execute();
}

/** One management call, carrying a freshly minted, body-bound control-plane token. */
async function call(path: string, body: unknown, scope: ControlPlaneScope, method = "POST") {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: signingKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: "ops@dashboard.test",
    scope,
    ...(payload === undefined ? {} : { body: new TextEncoder().encode(payload) }),
  });
  return buildApp().request(
    path,
    {
      method,
      headers: {
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        [CONTROL_PLANE_HEADER]: token,
        "cf-ray": "ray-823",
      },
      ...(payload === undefined ? {} : { body: payload }),
    },
    workerEnv(),
  );
}

class Terminal extends Error {}

/** A Workflow's step runner in miniature: a finished step is served from its journal and never re-run. */
const journal = () => {
  const done = new Map<string, unknown>();
  return {
    async do<T>(name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T> {
      const fn = (typeof configOrFn === "function" ? configOrFn : maybeFn) as () => Promise<T>;
      if (done.has(name)) return done.get(name) as T;
      const value = await fn();
      done.set(name, value);
      return value;
    },
  };
};

/** Run one organization's purge the way the adopter's Workflow class does, in the Worker that composed it. */
async function purge(organizationId: string) {
  buildApp();
  return runOrganizationPurge(workerEnv(), { payload: { organizationId } }, journal(), Terminal);
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.prepare(`drop table if exists ${table}`).run();
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
    { database: "app", namespace: "email", order: EMAIL_MIGRATION_ORDER, migrations: { "0001_init": email_0001_init } },
    {
      database: "app",
      namespace: "emailsuppressions",
      order: EMAIL_MIGRATION_ORDER + 10,
      migrations: { "0001_suppressions": email_0001_suppressions },
    },
    {
      database: "app",
      namespace: "controlplane",
      order: CONTROLPLANE_MIGRATION_ORDER,
      migrations: {
        "0001_init": controlplane_0001_init,
        "0002_management_origin": controlplane_0002_management_origin,
        "0003_connection_principal": controlplane_0003_connection_principal,
      },
    },
    {
      database: "app",
      namespace: "organization",
      order: ORGANIZATION_MIGRATION_ORDER,
      migrations: ORGANIZATION_MIGRATIONS,
    },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  await seedSecrets(env, REGISTRY, SECRETS);
  const now = new Date();
  const db = organizationDatabase(env.DB);
  await db
    .insertInto(ORGANIZATIONS_TABLE)
    .values(Organization.encode({ id: ACME, name: "Acme", slug: "acme", logo: null, createdAt: now, updatedAt: now }))
    .execute();
  await db
    .insertInto(MEMBERSHIPS_TABLE)
    .values(
      Membership.encode({ id: crypto.randomUUID(), organizationId: ACME, userId: "u1", role: "owner", createdAt: now }),
    )
    .execute();
  emitted = [];
  await grant([ORGANIZATION_ACCOUNTS_DELETE_SCOPE, ERASURE_READ_SCOPE]);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("an organization's erasure, attested through the control plane (#823)", () => {
  const remove = (body: unknown) =>
    call(`/organizations/admin/organizations/${ACME}`, body, ORGANIZATION_ACCOUNTS_DELETE_SCOPE, "DELETE");
  const attest = () => call(`/control-plane/erasure/organization/${ACME}`, undefined, ERASURE_READ_SCOPE, "GET");

  test("attests a purged organization: the deletion, every step with its disposition, complete, each cited in its tenant's trail", async () => {
    expect((await remove({ mode: "hard", reason: "Closed the account." })).status).toBe(200);
    expect((await purge(ACME)).state).toBe("purged");

    const response = await attest();
    expect(response.status).toBe(200);
    const { attestation } = ControlPlaneErasureSubjectResponse.parse(await response.json());
    expect(attestation).toMatchObject({
      subject: { type: "organization", id: ACME },
      deletion: {
        actorType: "control-plane",
        reason: "Closed the account.",
        mode: "hard",
        audit: { action: OrganizationAuditActions.adminOrganizationHardDeleted },
      },
      state: "complete",
      overdue: false,
      stoppedAt: null,
      trail: "recorded",
      completion: { action: OrganizationAuditActions.purged },
      failure: null,
    });
    expect(attestation.steps.map((step) => [step.capability, step.disposition])).toEqual([["organization", "erased"]]);
    // Every step and the completion are cited by id and chain position, each its own event in the organization's
    // own chain.
    const cited = [...attestation.steps.map((step) => step.audit), attestation.completion];
    expect(cited.every((each) => each !== null && each.seq !== null)).toBe(true);
    expect(new Set(cited.map((each) => each?.eventId)).size).toBe(cited.length);
    const purgeEvents = emitted.filter(
      (event) =>
        event.action === OrganizationAuditActions.purgeStep || event.action === OrganizationAuditActions.purged,
    );
    expect(purgeEvents.map((event) => event.tenant)).toEqual([ACME, ACME]);
  });

  test("the period counts the organization's purge, and names one that came due before the window and never ran", async () => {
    expect((await remove({ mode: "hard", reason: "Closed the account." })).status).toBe(200);
    expect((await purge(ACME)).state).toBe("purged");
    let body = ControlPlaneErasurePeriodResponse.parse(
      await (await call("/control-plane/erasure", undefined, ERASURE_READ_SCOPE, "GET")).json(),
    );
    expect(body.subjects).toEqual(["user", "organization"]);
    expect(body.counts).toMatchObject({ complete: 1, failed: 0, overdue: 0 });
    expect(body.attention).toEqual([]);

    // A second organization deleted 130 days ago and due 100 days ago, before the default 90-day window opened,
    // whose purge never started: outstanding the whole quarter, so the quarter's read names it.
    const BETA = "22222222-2222-4222-8222-222222222222";
    const now = Date.now();
    await env.DB.prepare(
      "insert into pithy_organization_lifecycle (organization_id, action, actor_type, mode, purge_after, created_at) values (?, 'deleted', 'control-plane', 'soft', ?, ?)",
    )
      .bind(BETA, now - 100 * DAY, now - 130 * DAY)
      .run();
    body = ControlPlaneErasurePeriodResponse.parse(
      await (await call("/control-plane/erasure", undefined, ERASURE_READ_SCOPE, "GET")).json(),
    );
    expect(body.counts).toMatchObject({ complete: 1, overdue: 1 });
    expect(body.attention).toEqual([
      expect.objectContaining({ subject: { type: "organization", id: BETA }, overdue: true, stoppedAt: "due" }),
    ]);
  });
});
