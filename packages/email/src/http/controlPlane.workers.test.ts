// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import { EmailJob } from "../data/emailJob";
import type { EmailJobStatus } from "../data/enums";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { listSuppressions, suppress } from "../send/suppression";
import {
  EMAIL_JOBS_READ_SCOPE,
  EMAIL_JOBS_RETRY_SCOPE,
  EMAIL_SUPPRESSIONS_DELETE_SCOPE,
  EMAIL_SUPPRESSIONS_READ_SCOPE,
  EMAIL_SUPPRESSIONS_WRITE_SCOPE,
} from "./guards";
import {
  EmailJobResponse,
  EmailJobRetryResponse,
  EmailJobsResponse,
  EmailSuppressionsResponse,
  EmailSuppressResponse,
  EmailUnsuppressResponse,
} from "./responses";
import { registerEmailAdminRoutes } from "./routes";

/**
 * The control-plane handlers, actually executed.
 *
 * `routeContract.test.ts` calls each of these with no credential and asserts 403, which proves the
 * guard runs and nothing else — every handler body is unreached there. What lives inside these bodies
 * is the whole security design of the surface: the projections that decide what a management client
 * sees, the retry's state check and suppression check, and the audit events that are the only record a
 * silent block ever happened. A guard nothing exercises is a comment.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const CONTROL_PLANE_ISSUER = "https://dashboard.example";
const CONTROL_PLANE_KEY_ID = "key-1";
const ENVIRONMENT = "prod";

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];
let dispatched: string[][] = [];
let dispatchFails = false;
let sequence = 0;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: CONTROL_PLANE_ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/",
    scopes: [...scopes],
    keys: [
      {
        keyId: CONTROL_PLANE_KEY_ID,
        publicKey: await exportPublicJwk(keys.publicKey),
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: new Date(NOW.getTime() - 86_400_000),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
}

function verifier(scopes: readonly ControlPlaneScope[]): ControlPlaneVerifier {
  const registered = connection(scopes);
  const spent = new Set<string>();
  return createControlPlaneVerifier({
    loadConnection: async (id) => {
      const row = await registered;
      return id === row.id ? row : null;
    },
    countConnections: async () => 1,
    replay: {
      async claim(jti) {
        if (spent.has(jti)) return false;
        spent.add(jti);
        return true;
      },
    },
    environment: ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => NOW,
  });
}

/** The app, with a live control-plane verifier and a capturing audit seam. */
function makeApp(scopes: readonly ControlPlaneScope[]): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(scopes);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  registerEmailAdminRoutes({ basePath: "/email", now: () => NOW })(app);
  return app;
}

/** The send Workflow binding, captured rather than started. */
const EMAIL_SENDER = {
  create: async (options: { params: { jobIds: string[] } }) => {
    if (dispatchFails) throw new Error("workflow unavailable");
    dispatched.push(options.params.jobIds);
    return {};
  },
};

/** A request carrying a freshly minted, body-bound control-plane token. */
async function call(
  app: Hono<PithyHonoEnv>,
  method: string,
  path: string,
  scope: ControlPlaneScope,
  body?: unknown,
): Promise<Response> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: CONTROL_PLANE_KEY_ID,
    issuer: CONTROL_PLANE_ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    body: payload === undefined ? undefined : new TextEncoder().encode(payload),
    now: () => NOW,
  });
  return app.request(
    `http://x${path}`,
    { method, headers: { "content-type": "application/json", [CONTROL_PLANE_HEADER]: token }, body: payload },
    { ...env, ENVIRONMENT, EMAIL_SENDER },
  );
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

/** Insert one job row directly — `enqueueEmail` renders a template, and these tests are about reads. */
async function seedJob(overrides: Partial<EmailJob> = {}): Promise<EmailJob> {
  const n = ++sequence;
  const job: EmailJob = {
    id: `job-${n}`,
    toAddress: `person${n}@example.com`,
    recipientKey: `person${n}@example.com`,
    fromAddress: "noreply@pithy.sh",
    fromName: "Pithy",
    subject: "Your sign-in link",
    template: "magicLink",
    category: "transactional",
    payload: { url: "https://api.example.test/auth/magic?token=SUPER-SECRET", name: "Ada Lovelace" },
    status: "sent",
    mode: "immediate",
    attempts: 1,
    // Distinct, increasing creation times so the ordering under test is the one the rows actually have.
    sendAt: new Date(NOW.getTime() - 86_400_000 + n * 1000),
    timezone: null,
    localTime: null,
    campaignId: null,
    openTracking: false,
    clickTracking: false,
    messageId: null,
    error: null,
    bounceCode: null,
    bounceType: null,
    replyTo: null,
    inReplyTo: null,
    references: null,
    createdAt: new Date(NOW.getTime() - 86_400_000 + n * 1000),
    updatedAt: NOW,
    sentAt: null,
    ...overrides,
  };
  await emailDatabase(env.DB).insertInto("pithyEmailJobs").values(EmailJob.encode(job)).execute();
  return job;
}

/** A job that exhausted its retry budget and failed — the row this surface exists for. */
async function failedJob(overrides: Partial<EmailJob> = {}): Promise<EmailJob> {
  return seedJob({ status: "failed", attempts: 3, error: "smtp_temporary_failure", ...overrides });
}

async function jobStatus(id: string): Promise<{ status: EmailJobStatus; attempts: number }> {
  const row = await emailDatabase(env.DB)
    .selectFrom("pithyEmailJobs")
    .select(["status", "attempts"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return { status: row.status as EmailJobStatus, attempts: row.attempts };
}

beforeEach(async () => {
  const app = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  const global = createDatabase(env.EMAIL_SUPPRESSIONS, {}) as unknown as Kysely<unknown>;
  for (const table of ["pithy_email_events", "pithy_email_jobs"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await env.EMAIL_SUPPRESSIONS.exec("DROP TABLE IF EXISTS pithy_email_suppressions");
  await email_0001_init.up(app);
  await email_0001_suppressions.up(global);
  emitted = [];
  dispatched = [];
  dispatchFails = false;
  sequence = 0;
});

describe("GET /email/jobs", () => {
  test("lists the log newest first, and masks every recipient in it", async () => {
    await seedJob();
    await seedJob();
    const response = await call(makeApp([EMAIL_JOBS_READ_SCOPE]), "GET", "/email/jobs", EMAIL_JOBS_READ_SCOPE);
    expect(response.status).toBe(200);
    const body = await response.text();

    // The projection is the boundary, and this is the assertion that would catch a `selectAll()` row
    // spread into a response by somebody in a hurry.
    expect(body).not.toContain("person1@example.com");
    expect(body).not.toContain("person2@example.com");
    expect(body).not.toContain("SUPER-SECRET");
    expect(body).not.toContain("Ada Lovelace");
    expect(body).toContain("pe***@example.com");

    const { jobs } = JSON.parse(body) as { jobs: { id: string }[] };
    expect(jobs.map((j) => j.id)).toEqual(["job-2", "job-1"]);
  });

  test("filters by status", async () => {
    await seedJob();
    const failed = await failedJob();
    const response = await call(
      makeApp([EMAIL_JOBS_READ_SCOPE]),
      "GET",
      "/email/jobs?status=failed",
      EMAIL_JOBS_READ_SCOPE,
    );
    const { jobs } = await response.json<{ jobs: { id: string }[] }>();
    expect(jobs.map((j) => j.id)).toEqual([failed.id]);
  });

  test("pages on a cursor, never an offset — a row inserted mid-scroll does not shift the next page", async () => {
    // The whole reason keyset paging is mandatory here. With OFFSET, the send that lands between the
    // two requests below pushes a row from page one onto page two and the reader sees it twice.
    for (let i = 0; i < 4; i++) await seedJob();
    const app = makeApp([EMAIL_JOBS_READ_SCOPE]);

    const first = await call(app, "GET", "/email/jobs?limit=2", EMAIL_JOBS_READ_SCOPE);
    const page1 = await first.json<{ jobs: { id: string }[]; nextCursor: string | null }>();
    expect(page1.jobs.map((j) => j.id)).toEqual(["job-4", "job-3"]);
    expect(page1.nextCursor).toBeTruthy();

    await seedJob(); // arrives at the head, between the two reads

    const second = await call(
      app,
      "GET",
      `/email/jobs?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`,
      EMAIL_JOBS_READ_SCOPE,
    );
    const page2 = await second.json<{ jobs: { id: string }[]; nextCursor: string | null }>();
    expect(page2.jobs.map((j) => j.id)).toEqual(["job-2", "job-1"]);
    expect(page2.nextCursor).toBeNull();
  });

  test("a malformed cursor is a first page, not a 500", async () => {
    await seedJob();
    const response = await call(
      makeApp([EMAIL_JOBS_READ_SCOPE]),
      "GET",
      "/email/jobs?cursor=not-a-cursor",
      EMAIL_JOBS_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    expect((await response.json<{ jobs: unknown[] }>()).jobs).toHaveLength(1);
  });

  test("the read is audited, with the filter and the count but not the rows", async () => {
    await seedJob();
    await call(makeApp([EMAIL_JOBS_READ_SCOPE]), "GET", "/email/jobs?status=sent", EMAIL_JOBS_READ_SCOPE);
    const event = emitted.find((e) => e.action === "email/jobs_read");
    expect(event?.actorType).toBe("control-plane");
    expect(event?.actorId).toBe("operator-1");
    expect(event?.metadata).toMatchObject({ status: "sent", returned: 1 });
    expect(JSON.stringify(event?.metadata)).not.toContain("person1@example.com");
  });
});

describe("GET /email/jobs/:id", () => {
  test("gives the whole address and the subject, one job at a time, and still no payload", async () => {
    const job = await seedJob();
    const response = await call(
      makeApp([EMAIL_JOBS_READ_SCOPE]),
      "GET",
      `/email/jobs/${job.id}`,
      EMAIL_JOBS_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("person1@example.com");
    expect(body).toContain("Your sign-in link");
    // The payload holds a working sign-in URL. No scope, no route, no flag projects it.
    expect(body).not.toContain("SUPER-SECRET");
    expect(body).not.toContain("Ada Lovelace");
  });

  test("an unknown job is a plain 404 that says nothing about which ids exist", async () => {
    const response = await call(makeApp([EMAIL_JOBS_READ_SCOPE]), "GET", "/email/jobs/job-nope", EMAIL_JOBS_READ_SCOPE);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("core/not_found");
  });

  test("the disclosure is audited against the job it disclosed", async () => {
    const job = await seedJob();
    await call(makeApp([EMAIL_JOBS_READ_SCOPE]), "GET", `/email/jobs/${job.id}`, EMAIL_JOBS_READ_SCOPE);
    const event = emitted.find((e) => e.action === "email/job_read");
    expect(event?.resourceId).toBe(job.id);
  });
});

describe("POST /email/jobs/:id/retry", () => {
  test("re-queues a failed job with a fresh attempt budget and dispatches the Workflow", async () => {
    const job = await failedJob();
    const response = await call(
      makeApp([EMAIL_JOBS_RETRY_SCOPE]),
      "POST",
      `/email/jobs/${job.id}/retry`,
      EMAIL_JOBS_RETRY_SCOPE,
    );
    expect(response.status).toBe(200);
    expect(await jobStatus(job.id)).toEqual({ status: "pending", attempts: 0 });
    expect(dispatched).toEqual([[job.id]]);
  });

  test("attempts really are reset, or the button changes nothing", async () => {
    // `runSend` gives up once `attempts >= maxAttempts`, so a retry that left the count alone would
    // take one retryable error to fail terminally again — and this whole route would be theatre.
    const job = await failedJob({ attempts: 99 });
    await call(makeApp([EMAIL_JOBS_RETRY_SCOPE]), "POST", `/email/jobs/${job.id}/retry`, EMAIL_JOBS_RETRY_SCOPE);
    expect((await jobStatus(job.id)).attempts).toBe(0);
  });

  test("a failed dispatch still leaves the job queued for the scheduler", async () => {
    const job = await failedJob();
    dispatchFails = true;
    const response = await call(
      makeApp([EMAIL_JOBS_RETRY_SCOPE]),
      "POST",
      `/email/jobs/${job.id}/retry`,
      EMAIL_JOBS_RETRY_SCOPE,
    );
    expect(response.status).toBe(200);
    expect((await response.json<{ dispatched: boolean }>()).dispatched).toBe(false);
    // Pending, so the every-minute scheduler re-drives it. Losing the dispatch costs a minute, not an
    // email — which is why swallowing it is safe and reporting it is honest.
    expect((await jobStatus(job.id)).status).toBe("pending");
  });

  test.each(["sent", "pending", "sending", "scheduled", "cancelled", "bounced", "suppressed"] as const)(
    "refuses a job that is %s",
    async (status) => {
      const job = await seedJob({ status });
      const response = await call(
        makeApp([EMAIL_JOBS_RETRY_SCOPE]),
        "POST",
        `/email/jobs/${job.id}/retry`,
        EMAIL_JOBS_RETRY_SCOPE,
      );
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("core/conflict");
      expect(dispatched).toEqual([]);
      expect((await jobStatus(job.id)).status).toBe(status);
    },
  );

  test("refuses to re-send to an address that has since been suppressed", async () => {
    // The one send this capability must never make. `runSend` would notice and mark the row
    // `suppressed`, which reports to an operator as a retry that worked and sent nothing.
    const job = await failedJob();
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: job.toAddress, reason: "complaint" },
      NOW,
    );

    const response = await call(
      makeApp([EMAIL_JOBS_RETRY_SCOPE]),
      "POST",
      `/email/jobs/${job.id}/retry`,
      EMAIL_JOBS_RETRY_SCOPE,
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("email/suppressed");
    expect(dispatched).toEqual([]);
    expect((await jobStatus(job.id)).status).toBe("failed");
  });

  test("an unsubscribe does not block retrying a sign-in link, but does block a newsletter", async () => {
    // The retry check asks the question the same way `runSend` does, kind included. Refusing here for a
    // send that would go through would be this route inventing a block of its own, and telling an
    // operator an account is unreachable when it is not.
    const login = await failedJob();
    const digest = await failedJob({ template: "newsletter", category: "marketing" });
    const suppressionDb = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    await suppress(suppressionDb, { email: login.toAddress, reason: "unsubscribe" }, NOW);
    await suppress(suppressionDb, { email: digest.toAddress, reason: "unsubscribe" }, NOW);
    const app = makeApp([EMAIL_JOBS_RETRY_SCOPE]);

    const allowed = await call(app, "POST", `/email/jobs/${login.id}/retry`, EMAIL_JOBS_RETRY_SCOPE);
    expect(allowed.status).toBe(200);
    expect(dispatched).toEqual([[login.id]]);

    const refused = await call(app, "POST", `/email/jobs/${digest.id}/retry`, EMAIL_JOBS_RETRY_SCOPE);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("email/suppressed");
    expect(dispatched).toEqual([[login.id]]);
  });

  test("an expired suppression does not block the retry", async () => {
    const job = await failedJob();
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: job.toAddress, reason: "hard_bounce", expiresAt: new Date(NOW.getTime() - 1000) },
      NOW,
    );
    const response = await call(
      makeApp([EMAIL_JOBS_RETRY_SCOPE]),
      "POST",
      `/email/jobs/${job.id}/retry`,
      EMAIL_JOBS_RETRY_SCOPE,
    );
    expect(response.status).toBe(200);
    expect(dispatched).toEqual([[job.id]]);
  });

  test("two people pressing retry on the same visible failure send one email, not two", async () => {
    // The re-queue is a compare-and-set on `status = 'failed'`, not a read followed by a hopeful write.
    // Without it the loser resets a row the winner's Workflow has already claimed and dispatches a
    // second send of the same email — and a duplicate receipt is the kind of bug a customer reports.
    const job = await failedJob();
    const app = makeApp([EMAIL_JOBS_RETRY_SCOPE]);
    const [a, b] = await Promise.all([
      call(app, "POST", `/email/jobs/${job.id}/retry`, EMAIL_JOBS_RETRY_SCOPE),
      call(app, "POST", `/email/jobs/${job.id}/retry`, EMAIL_JOBS_RETRY_SCOPE),
    ]);

    expect(dispatched).toEqual([[job.id]]);
    // One wins, one is told the job is no longer failed. Which of the two wins is a race and is not
    // asserted; that exactly one does is the whole point.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(await errorCode(loser)).toBe("core/conflict");
  });

  test("the retry is audited as a warning naming the state it came from", async () => {
    const job = await failedJob();
    await call(makeApp([EMAIL_JOBS_RETRY_SCOPE]), "POST", `/email/jobs/${job.id}/retry`, EMAIL_JOBS_RETRY_SCOPE);
    const event = emitted.find((e) => e.action === "email/job_retried");
    expect(event?.severity).toBe("warning");
    expect(event?.resourceId).toBe(job.id);
    expect(event?.metadata).toMatchObject({ from: "failed", dispatched: true });
  });
});

describe("the suppression list", () => {
  test("lists blocked addresses in full, newest first, and says whether each is in force", async () => {
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    await suppress(db, { email: "old@example.com", reason: "unsubscribe" }, new Date(NOW.getTime() - 10_000));
    await suppress(db, { email: "new@example.com", reason: "hard_bounce" }, NOW);

    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_READ_SCOPE]),
      "GET",
      "/email/suppressions",
      EMAIL_SUPPRESSIONS_READ_SCOPE,
    );
    expect(response.status).toBe(200);
    const { suppressions } = await response.json<{ suppressions: { email: string; active: boolean }[] }>();
    expect(suppressions.map((s) => s.email)).toEqual(["new@example.com", "old@example.com"]);
    expect(suppressions.every((s) => s.active)).toBe(true);
  });

  test("looks one address up without disclosing anybody else", async () => {
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    await suppress(db, { email: "wanted@example.com", reason: "complaint" }, NOW);
    await suppress(db, { email: "other@example.com", reason: "complaint" }, NOW);

    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_READ_SCOPE]),
      "GET",
      "/email/suppressions?email=WANTED%40example.com",
      EMAIL_SUPPRESSIONS_READ_SCOPE,
    );
    const body = await response.text();
    // Normalised on the way in, so an operator typing it with capitals still finds the row.
    expect(body).toContain("wanted@example.com");
    expect(body).not.toContain("other@example.com");
  });

  test("filters by reason", async () => {
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    await suppress(db, { email: "bounced@example.com", reason: "hard_bounce" }, NOW);
    await suppress(db, { email: "left@example.com", reason: "unsubscribe" }, NOW);

    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_READ_SCOPE]),
      "GET",
      "/email/suppressions?reason=unsubscribe",
      EMAIL_SUPPRESSIONS_READ_SCOPE,
    );
    const { suppressions } = await response.json<{ suppressions: { email: string }[] }>();
    expect(suppressions.map((s) => s.email)).toEqual(["left@example.com"]);
  });

  test("the read is audited, and records whether it was a lookup or a walk", async () => {
    await call(makeApp([EMAIL_SUPPRESSIONS_READ_SCOPE]), "GET", "/email/suppressions", EMAIL_SUPPRESSIONS_READ_SCOPE);
    const event = emitted.find((e) => e.action === "email/suppressions_read");
    expect(event?.metadata).toMatchObject({ lookup: false });
  });
});

describe("POST /email/suppressions", () => {
  test("refuses to overwrite a bounce, a complaint, or somebody's own opt-out", async () => {
    // The write scope adds a block; it does not undo one. `suppress()` is an upsert, so without this
    // guard a `manual` write would rewrite a system-observed row — and, with an expiry, turn a
    // permanent block into a lapsing one. That is the act `email:suppressions:delete` gates, reached
    // from a scope that was never granted it. Exact scope matching gives no protection: the delete
    // route is simply not the route being called.
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    for (const reason of ["hard_bounce", "complaint", "unsubscribe"] as const) {
      const email = `${reason}@example.com`;
      await suppress(db, { email, reason }, NOW);

      const response = await call(
        makeApp([EMAIL_SUPPRESSIONS_WRITE_SCOPE]),
        "POST",
        "/email/suppressions",
        EMAIL_SUPPRESSIONS_WRITE_SCOPE,
        { email },
      );
      expect(response.status, `${reason} must not be overwritable`).toBe(409);

      // And the row is untouched — the compliance record of *why* the address was blocked survives.
      const stored = (await listSuppressions(db, { email, limit: 1 })).items[0];
      expect(stored?.reason).toBe(reason);
      expect(stored?.expiresAt ?? null).toBeNull();
    }
  });

  test("refuses an expiry in the past, which is an unblock wearing a block's clothes", async () => {
    // The send path decides purely on `expiresAt <= now`, so backdating one is exactly equivalent to
    // lifting the block.
    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_WRITE_SCOPE]),
      "POST",
      "/email/suppressions",
      EMAIL_SUPPRESSIONS_WRITE_SCOPE,
      { email: "someone@example.com", expiresAt: new Date(NOW.getTime() - 1000).toISOString() },
    );
    expect(response.status).toBe(400);
  });

  test("keeps the recipient address out of resourceId, which the audit listing projects", async () => {
    // `auditEventView` puts `resourceId` in the listing served under `audit:events:read`, which is
    // deliberately free of personal data — `metadata` is held back to `audit:events:read_detail` for
    // exactly this reason. An address here would let the everyday read scope page out every address the
    // adopter's staff has blocked, with neither the detail scope nor `email:suppressions:read`.
    await call(
      makeApp([EMAIL_SUPPRESSIONS_WRITE_SCOPE]),
      "POST",
      "/email/suppressions",
      EMAIL_SUPPRESSIONS_WRITE_SCOPE,
      { email: "private@example.com" },
    );

    const event = emitted.find((e) => e.action === "email/suppression_added");
    expect(event?.resourceId ?? "").not.toContain("@");
    // Still in the trail, one scope up — a silent block is invisible to everyone including the person
    // it affects.
    expect(event?.metadata).toMatchObject({ email: "private@example.com" });
  });

  test("blocks an address, always as a manual block", async () => {
    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_WRITE_SCOPE]),
      "POST",
      "/email/suppressions",
      EMAIL_SUPPRESSIONS_WRITE_SCOPE,
      { email: "Nuisance@Example.com", detail: "abuse report 4471" },
    );
    expect(response.status).toBe(200);
    const { suppression } = await response.json<{ suppression: { email: string; reason: string; detail: string } }>();
    // Normalised, so the send path's check finds the same key this wrote.
    expect(suppression.email).toBe("nuisance@example.com");
    // `manual`, and not negotiable: the other three reasons are observations the system made, and a
    // management client made none of them. An operator's assertion must not enter the record as one.
    expect(suppression.reason).toBe("manual");
    expect(suppression.detail).toBe("abuse report 4471");
  });

  test("a caller cannot claim the block was a bounce", async () => {
    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_WRITE_SCOPE]),
      "POST",
      "/email/suppressions",
      EMAIL_SUPPRESSIONS_WRITE_SCOPE,
      { email: "nuisance@example.com", reason: "hard_bounce" },
    );
    // The schema has no `reason`, so the claim is dropped at the boundary and never reaches `suppress`.
    // The response echoes the row that was actually stored, so a client that tried is told what
    // happened in the same breath rather than being left believing its value was honoured.
    expect(response.status).toBe(200);
    const { suppression } = await response.json<{ suppression: { reason: string } }>();
    expect(suppression.reason).toBe("manual");

    // And the audit trail agrees, which is the copy of this fact that outlives the response.
    expect(emitted.find((e) => e.action === "email/suppression_added")?.metadata).toMatchObject({ reason: "manual" });
  });

  test("a time-boxed block expires on its own", async () => {
    await call(
      makeApp([EMAIL_SUPPRESSIONS_WRITE_SCOPE]),
      "POST",
      "/email/suppressions",
      EMAIL_SUPPRESSIONS_WRITE_SCOPE,
      { email: "temporary@example.com", expiresAt: new Date(NOW.getTime() + 3600_000).toISOString() },
    );
    const list = await call(
      makeApp([EMAIL_SUPPRESSIONS_READ_SCOPE]),
      "GET",
      "/email/suppressions?email=temporary@example.com",
      EMAIL_SUPPRESSIONS_READ_SCOPE,
    );
    const { suppressions } = await list.json<{ suppressions: { expiresAt: string | null; active: boolean }[] }>();
    expect(suppressions[0]?.expiresAt).toBe(new Date(NOW.getTime() + 3600_000).toISOString());
    expect(suppressions[0]?.active).toBe(true);
  });

  test("a malformed address is refused rather than blocking nothing forever", async () => {
    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_WRITE_SCOPE]),
      "POST",
      "/email/suppressions",
      EMAIL_SUPPRESSIONS_WRITE_SCOPE,
      { email: "not-an-address" },
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation/invalid_input");
  });

  test("the block is audited with the address, because nothing else records it", async () => {
    await call(
      makeApp([EMAIL_SUPPRESSIONS_WRITE_SCOPE]),
      "POST",
      "/email/suppressions",
      EMAIL_SUPPRESSIONS_WRITE_SCOPE,
      { email: "quiet@example.com" },
    );
    const event = emitted.find((e) => e.action === "email/suppression_added");
    expect(event?.severity).toBe("warning");
    expect(event?.metadata).toMatchObject({ email: "quiet@example.com", reason: "manual" });
  });
});

describe("POST /email/suppressions/remove", () => {
  test("unblocks an address and says so", async () => {
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: "back@example.com", reason: "manual" },
      NOW,
    );
    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_DELETE_SCOPE]),
      "POST",
      "/email/suppressions/remove",
      EMAIL_SUPPRESSIONS_DELETE_SCOPE,
      { email: "back@example.com" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "back@example.com", removed: true });
  });

  test("removing something that was never there is not an error, and is recorded as a miss", async () => {
    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_DELETE_SCOPE]),
      "POST",
      "/email/suppressions/remove",
      EMAIL_SUPPRESSIONS_DELETE_SCOPE,
      { email: "never@example.com" },
    );
    expect(response.status).toBe(200);
    expect((await response.json<{ removed: boolean }>()).removed).toBe(false);
    const event = emitted.find((e) => e.action === "email/suppression_removed");
    expect(event?.metadata).toMatchObject({ removed: false, reason: null });
  });

  test("the trail records what was undone, not merely that something was", async () => {
    // Lifting a hard bounce and lifting somebody's own unsubscribe are not the same act, and once the
    // row is gone there is nothing left to tell them apart.
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: "left@example.com", reason: "unsubscribe" },
      NOW,
    );
    await call(
      makeApp([EMAIL_SUPPRESSIONS_DELETE_SCOPE]),
      "POST",
      "/email/suppressions/remove",
      EMAIL_SUPPRESSIONS_DELETE_SCOPE,
      { email: "left@example.com" },
    );
    const event = emitted.find((e) => e.action === "email/suppression_removed");
    expect(event?.severity).toBe("warning");
    expect(event?.metadata).toMatchObject({ email: "left@example.com", removed: true, reason: "unsubscribe" });
  });

  test("an address a validator would refuse can still be unblocked", async () => {
    // Inbound bounces write whatever the remote server reported. An undo that could not reach those
    // rows would leave an operator watching a malformed suppression hold mail with no way to lift it.
    await emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS)
      .insertInto("pithyEmailSuppressions")
      .values({ email: "weird..address@example", reason: "hard_bounce", createdAt: SQLiteDate.encode(NOW) })
      .execute();
    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_DELETE_SCOPE]),
      "POST",
      "/email/suppressions/remove",
      EMAIL_SUPPRESSIONS_DELETE_SCOPE,
      { email: "weird..address@example" },
    );
    expect(response.status).toBe(200);
    expect((await response.json<{ removed: boolean }>()).removed).toBe(true);
  });
});

describe("the five scopes are not interchangeable", () => {
  test("a read credential cannot retry", async () => {
    const job = await failedJob();
    const response = await call(
      makeApp([EMAIL_JOBS_READ_SCOPE]),
      "POST",
      `/email/jobs/${job.id}/retry`,
      EMAIL_JOBS_READ_SCOPE,
    );
    expect(response.status).toBe(403);
    expect(dispatched).toEqual([]);
  });

  test("a retry credential cannot read the log it would choose from", async () => {
    await failedJob();
    const response = await call(makeApp([EMAIL_JOBS_RETRY_SCOPE]), "GET", "/email/jobs", EMAIL_JOBS_RETRY_SCOPE);
    expect(response.status).toBe(403);
  });

  test("a jobs credential cannot read the suppression list", async () => {
    // Its own scope because that database is global: a page of it is every environment's bounces,
    // complaints, and opt-outs, which is a different disclosure from one environment's send log.
    const response = await call(makeApp([EMAIL_JOBS_READ_SCOPE]), "GET", "/email/suppressions", EMAIL_JOBS_READ_SCOPE);
    expect(response.status).toBe(403);
  });

  test("a credential that may block may not unblock", async () => {
    // The asymmetry that matters most. Blocking is reversible and cautious; unblocking re-opens
    // sending to somebody who reported spam or asked to be left alone.
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: "held@example.com", reason: "complaint" },
      NOW,
    );
    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_WRITE_SCOPE]),
      "POST",
      "/email/suppressions/remove",
      EMAIL_SUPPRESSIONS_WRITE_SCOPE,
      { email: "held@example.com" },
    );
    expect(response.status).toBe(403);
  });

  test("and one that may unblock may not block", async () => {
    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_DELETE_SCOPE]),
      "POST",
      "/email/suppressions",
      EMAIL_SUPPRESSIONS_DELETE_SCOPE,
      { email: "someone@example.com" },
    );
    expect(response.status).toBe(403);
  });

  test("a suppression-read credential cannot read the send log", async () => {
    await seedJob();
    const response = await call(
      makeApp([EMAIL_SUPPRESSIONS_READ_SCOPE]),
      "GET",
      "/email/jobs",
      EMAIL_SUPPRESSIONS_READ_SCOPE,
    );
    expect(response.status).toBe(403);
  });
});

describe("the exported response schemas against the live routes", () => {
  /**
   * The binding between what a route returns and what a management client is told it returns.
   *
   * Parsing alone would not do it: a Zod object strips unknown keys, so a handler that grew a field
   * would still parse. Comparing the parsed value with the raw body fails in both directions — a field
   * the schema does not know about is dropped and shows as a difference, and a field it declares
   * wrongly fails the parse. That is what stops the two from drifting silently, and it is why a
   * management client can import these objects instead of hand-writing a mirror of each.
   */
  async function contract<T>(
    schema: z.ZodType<T>,
    scope: ControlPlaneScope,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await call(makeApp([scope]), method, path, scope, body);
    expect(response.status, path).toBe(200);
    const raw = await response.json();
    expect(schema.parse(raw), path).toEqual(raw);
    return schema.parse(raw);
  }

  test("every management route returns exactly its declared envelope", async () => {
    const job = await failedJob({ campaignId: "camp-1", messageId: "msg-1", bounceCode: "5.1.1", bounceType: "hard" });
    await seedJob();
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: "blocked@example.com", reason: "hard_bounce", jobId: job.id, environment: "prod", detail: "5.1.1" },
      NOW,
    );

    // A limit of one, so the paged branch is under test — a schema proven only on the last page says
    // nothing about the cursor a client actually pages with.
    const jobs = await contract(EmailJobsResponse, EMAIL_JOBS_READ_SCOPE, "GET", "/email/jobs?limit=1");
    expect(jobs.nextCursor).not.toBeNull();

    await contract(EmailJobResponse, EMAIL_JOBS_READ_SCOPE, "GET", `/email/jobs/${job.id}`);
    await contract(EmailJobRetryResponse, EMAIL_JOBS_RETRY_SCOPE, "POST", `/email/jobs/${job.id}/retry`);
    await contract(EmailSuppressionsResponse, EMAIL_SUPPRESSIONS_READ_SCOPE, "GET", "/email/suppressions");
    await contract(EmailSuppressResponse, EMAIL_SUPPRESSIONS_WRITE_SCOPE, "POST", "/email/suppressions", {
      email: "manual@example.com",
      detail: "asked us to stop",
    });
    await contract(EmailUnsuppressResponse, EMAIL_SUPPRESSIONS_DELETE_SCOPE, "POST", "/email/suppressions/remove", {
      email: "manual@example.com",
    });
  });
});
