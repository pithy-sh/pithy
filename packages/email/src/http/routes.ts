// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { ConflictError, InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import type { Context, Hono } from "hono";
import { EmailAuditActions } from "../audit/actions";
import {
  type EmailDatabase,
  type EmailSuppressionDatabase,
  emailDatabase,
  emailSuppressionDatabase,
} from "../data/tables";
import { getJob, listJobs } from "../jobs/read";
import { retryJob } from "../jobs/retry";
import type { SendWorkflowBinding } from "../send/enqueue";
import { emailSenderBinding } from "../send/senderBinding";
import { listSuppressions, suppress, unsuppress } from "../send/suppression";
import {
  EMAIL_JOBS_READ_SCOPE,
  EMAIL_JOBS_RETRY_SCOPE,
  EMAIL_SUPPRESSIONS_DELETE_SCOPE,
  EMAIL_SUPPRESSIONS_READ_SCOPE,
  EMAIL_SUPPRESSIONS_WRITE_SCOPE,
} from "./guards";
import type {
  EmailJobResponse,
  EmailJobRetryResponse,
  EmailJobsResponse,
  EmailSuppressionsResponse,
  EmailSuppressResponse,
  EmailUnsuppressResponse,
} from "./responses";
import { JobIdParam, JobsQuery, SuppressionsQuery, SuppressRequest, UnsuppressRequest } from "./schemas";
import { jobDetailView, jobListView, suppressionView } from "./view";

/**
 * The email management routes, their declared verification strategies, and what each accepts:
 *
 *   GET  /email/jobs                 → the send log        (control-plane: email:jobs:read)             query
 *   GET  /email/jobs/:id             → one job in full     (control-plane: email:jobs:read)             param
 *   POST /email/jobs/:id/retry       → queue it again      (control-plane: email:jobs:retry)            param
 *   GET  /email/suppressions         → who we won't mail   (control-plane: email:suppressions:read)     query
 *   POST /email/suppressions         → block an address    (control-plane: email:suppressions:write)    json
 *   POST /email/suppressions/remove  → unblock one         (control-plane: email:suppressions:delete)   json
 *
 * **Every route here is `control-plane`, and there is no end-user surface in this file.** A recipient
 * interacts with email by receiving it; the three routes a recipient does call — click, open,
 * unsubscribe — live in `callbacks.ts`, are public, and are gated by the signature on the token in the
 * path. Nothing below has any business answering an ordinary user, and with the seam uncomposed every
 * one of them answers 403 `controlplane/not_connected`.
 *
 * **Validators sit after the gate on every line.** A validator ahead of it turns a 403 into a 400 and
 * tells an unverified caller which requests were well-formed — on this surface that is a live oracle
 * for the shape of the send log and, worse, a way to learn that a given address parses as one this
 * deployment would accept.
 *
 * **Every response has an exported schema**, in `responses.ts`, and each `c.json` below is
 * `satisfies`-checked against its envelope. A management client imports the same object and validates
 * with it rather than hand-writing a mirror that drifts. The check is at compile time on purpose:
 * parsing every response would spend a validation pass on rows this Worker just read, and would turn a
 * shape mistake into a 500 in production rather than a red build.
 *
 * **Removal is a POST with a body, not `DELETE /suppressions/:email`.** An address in a path is an
 * address in every access log, every proxy, every trace, and every referrer between the client and the
 * Worker. The record is personal data whether or not it is a person's current address, so it travels in
 * a body. Testers' `POST /remove` is the same call made for the same reason.
 */

/** What every route this capability mounts declares: its path, its strategy, and the scope it checks. */
export interface EmailRouteDeclaration {
  readonly method: "GET" | "POST";
  /** The path relative to the configured `basePath`, e.g. `/jobs`. */
  readonly path: string;
  readonly strategy: VerificationStrategy;
  /** The control-plane scope this route checks. */
  readonly scope: ControlPlaneScope;
}

/**
 * Every management route, and how it is gated.
 *
 * Exported so a test can assert against the declaration rather than against a middleware count. A count
 * proves that *something* runs before the handler — a bare `zValidator` satisfies it — and cannot prove
 * *what*. `routeContract.test.ts` checks this list against the paths Hono actually registered, in both
 * directions, so a route added without an entry and an entry without a route both fail.
 */
export const EMAIL_ADMIN_ROUTES: readonly EmailRouteDeclaration[] = [
  { method: "GET", path: "/jobs", strategy: "control-plane", scope: EMAIL_JOBS_READ_SCOPE },
  { method: "GET", path: "/jobs/:id", strategy: "control-plane", scope: EMAIL_JOBS_READ_SCOPE },
  { method: "POST", path: "/jobs/:id/retry", strategy: "control-plane", scope: EMAIL_JOBS_RETRY_SCOPE },
  { method: "GET", path: "/suppressions", strategy: "control-plane", scope: EMAIL_SUPPRESSIONS_READ_SCOPE },
  { method: "POST", path: "/suppressions", strategy: "control-plane", scope: EMAIL_SUPPRESSIONS_WRITE_SCOPE },
  {
    method: "POST",
    path: "/suppressions/remove",
    strategy: "control-plane",
    scope: EMAIL_SUPPRESSIONS_DELETE_SCOPE,
  },
];

/** The bindings the management routes read off the request env. */
interface AdminEnv {
  DB?: D1Database;
  EMAIL_SUPPRESSIONS?: D1Database;
  EMAIL_SENDER?: SendWorkflowBinding;
  /** Stamped by `pithy init`. Read only to decide whether a local host may stand in for the binding. */
  ENVIRONMENT?: string;
  /** The local email host's address under `pithy dev`. See {@link emailSenderBinding}. */
  EMAIL_ORIGIN?: string;
}

/** How the email management sub-router is built. */
export interface EmailAdminRoutesOptions {
  /**
   * Where the routes mount.
   *
   * Required, with no default of its own. The manifest advertises these paths and a client composes its
   * calls from the manifest, so the mount point and the advertised path must come from one value — a
   * default here and a default in the config is two, and the day they disagree every management call
   * 404s against exactly the adopters who customised anything.
   */
  basePath: string;
  /** The clock. Injected so retried timestamps are deterministic in tests. */
  now?: () => Date;
}

/**
 * A required D1 binding, or a stated wiring failure.
 *
 * `email()` declares both databases in `requiredBindings`, so an absent one is a Worker assembled
 * wrong rather than a request doing anything unusual — hence a 500 that names the fix, not a 4xx that
 * blames the caller.
 */
function d1(c: Context<PithyHonoEnv>, binding: "DB" | "EMAIL_SUPPRESSIONS"): D1Database {
  const found = (c.env as AdminEnv)[binding];
  if (!found) {
    throw new InternalError({
      message: "Email is not fully configured on this Worker.",
      action: `Bind a D1 database named ${binding} in wrangler.jsonc, then run pithy migrate.`,
      detail: `the email management routes require a \`${binding}\` D1 binding; none was present on env`,
    });
  }
  return found;
}

/** The per-environment jobs database. */
function jobs(c: Context<PithyHonoEnv>): EmailDatabase {
  return emailDatabase(d1(c, "DB"));
}

/** The global suppression database. */
function suppressions(c: Context<PithyHonoEnv>): EmailSuppressionDatabase {
  return emailSuppressionDatabase(d1(c, "EMAIL_SUPPRESSIONS"));
}

/**
 * The verified management caller.
 *
 * `requireControlPlane()` has run on every route in this file, so a null here is a route mounted
 * without its gate — a programming error, not an unauthenticated request, and therefore an internal
 * error rather than a 401 that would imply a credential could fix it.
 */
function caller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const context = c.var.controlPlane;
  if (!context) {
    throw new InternalError({
      message: "Email could not identify the management caller.",
      detail: "requireControlPlane() must run before an email handler reads the caller.",
    });
  }
  return context;
}

/** Register the email management sub-router. Composed alongside the public callbacks. */
export function registerEmailAdminRoutes(options: EmailAdminRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath;
  const clock = options.now ?? (() => new Date());

  return (app) => {
    // ── the send log ──────────────────────────────────────────────────────────

    app.get(
      `${base}/jobs`,
      requireControlPlane(EMAIL_JOBS_READ_SCOPE),
      zValidator("query", JobsQuery, validationHook),
      async (c) => {
        const query = c.req.valid("query");
        const who = caller(c);
        const page = await listJobs(jobs(c), query);

        // Reads are audited too. A page of the send log is a page of who this project mailed, and a
        // credential quietly walking it is the event an adopter most needs to be able to find later.
        // The filter and the count go in metadata; the rows do not.
        await c.var.emit({
          action: EmailAuditActions.jobsRead,
          outcome: "success",
          actorType: "control-plane",
          actorId: who.subject,
          resourceType: "email_job",
          resourceId: null,
          metadata: {
            connectionId: who.connectionId,
            status: query.status ?? null,
            returned: page.items.length,
            paged: Boolean(query.cursor),
          },
        });

        return c.json({ jobs: page.items.map(jobListView), nextCursor: page.nextCursor } satisfies EmailJobsResponse);
      },
    );

    app.get(
      `${base}/jobs/:id`,
      requireControlPlane(EMAIL_JOBS_READ_SCOPE),
      zValidator("param", JobIdParam, validationHook),
      async (c) => {
        const { id } = c.req.valid("param");
        const who = caller(c);
        const job = await getJob(jobs(c), id);
        if (!job) {
          // `core/not_found`, saying nothing beyond "not here" — an id that exists and an id that does
          // not get the same words, so the route is not an oracle for which jobs this project sent.
          throw new NotFoundError({
            message: "No such email job.",
            action: "Check the job id against the send log.",
            detail: `email job '${id}' not found`,
          });
        }

        // The one route that discloses a whole address, so it is audited against the job it disclosed.
        await c.var.emit({
          action: EmailAuditActions.jobRead,
          outcome: "success",
          actorType: "control-plane",
          actorId: who.subject,
          resourceType: "email_job",
          resourceId: job.id,
          metadata: { connectionId: who.connectionId, status: job.status, template: job.template },
        });

        return c.json({ job: jobDetailView(job) } satisfies EmailJobResponse);
      },
    );

    app.post(
      `${base}/jobs/:id/retry`,
      requireControlPlane(EMAIL_JOBS_RETRY_SCOPE),
      zValidator("param", JobIdParam, validationHook),
      async (c) => {
        const { id } = c.req.valid("param");
        const who = caller(c);
        const now = clock();
        const db = jobs(c);
        // Read before write, and read what the row *was* — the audit event says which state this came
        // out of, and after the update there is nothing left to ask.
        const before = await getJob(db, id);
        const result = await retryJob(
          { db, suppressionDb: suppressions(c), sender: emailSenderBinding(c.env as AdminEnv), now },
          id,
        );

        // `warning`: this is the one operation in the capability that sends mail to a real person.
        await c.var.emit({
          action: EmailAuditActions.jobRetried,
          outcome: "success",
          severity: "warning",
          actorType: "control-plane",
          actorId: who.subject,
          resourceType: "email_job",
          resourceId: result.job.id,
          metadata: {
            connectionId: who.connectionId,
            from: before?.status ?? null,
            template: result.job.template,
            dispatched: result.dispatched,
          },
        });

        return c.json({
          job: jobDetailView(result.job),
          dispatched: result.dispatched,
        } satisfies EmailJobRetryResponse);
      },
    );

    // ── the suppression list ──────────────────────────────────────────────────

    app.get(
      `${base}/suppressions`,
      requireControlPlane(EMAIL_SUPPRESSIONS_READ_SCOPE),
      zValidator("query", SuppressionsQuery, validationHook),
      async (c) => {
        const query = c.req.valid("query");
        const who = caller(c);
        const now = clock();
        const page = await listSuppressions(suppressions(c), query);

        // The heaviest read in the capability: this database is global, so a page of it is a page of
        // every environment's bounces, complaints, and opt-outs. Audited with whether it was a lookup
        // or a walk, because those are very different events wearing the same route.
        await c.var.emit({
          action: EmailAuditActions.suppressionsRead,
          outcome: "success",
          actorType: "control-plane",
          actorId: who.subject,
          resourceType: "email_suppression",
          resourceId: null,
          metadata: {
            connectionId: who.connectionId,
            reason: query.reason ?? null,
            lookup: Boolean(query.email),
            returned: page.items.length,
            paged: Boolean(query.cursor),
          },
        });

        return c.json({
          suppressions: page.items.map((row) => suppressionView(row, now)),
          nextCursor: page.nextCursor,
        } satisfies EmailSuppressionsResponse);
      },
    );

    app.post(
      `${base}/suppressions`,
      requireControlPlane(EMAIL_SUPPRESSIONS_WRITE_SCOPE),
      zValidator("json", SuppressRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const who = caller(c);
        const now = clock();
        const email = normalizeAddress(input.email);
        const db = suppressions(c);

        // **A write must never weaken an existing block.** `suppress()` is an upsert, so without this
        // guard `email:suppressions:write` could rewrite a `hard_bounce`, `complaint`, or `unsubscribe`
        // row — every one of which the system writes with no expiry — into a `manual` one that lapses,
        // and the send path decides purely on `expiresAt <= now`. That is precisely the act
        // `email:suppressions:delete` exists to gate, reached from a scope that was never granted it.
        // `scopeCovers` matches exactly and offers no protection here: the delete route is simply not
        // the route being called.
        //
        // The upsert would also destroy the compliance record, forcing `reason` to `manual` and
        // clobbering the `jobId` and `detail` that say *why* the address was blocked.
        // An expiry in the past is not a block — it is an unblock wearing one, since the send path
        // decides purely on `expiresAt <= now`. Checked here rather than in the schema because the
        // route has an injected clock, and a schema reading the wall clock would ignore it.
        const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
        if (expiresAt && expiresAt.getTime() <= now.getTime()) {
          throw new ValidationError({
            message: "That expiry has already passed, so it would not block anything.",
            action:
              "Give a future instant, or omit `expiresAt` to block permanently. To lift an existing block, use the remove route — it requires `email:suppressions:delete`.",
            detail: `refused suppression for ${email} with expiresAt ${expiresAt.toISOString()} at ${now.toISOString()}`,
          });
        }

        const current = (await listSuppressions(db, { email, limit: 1 })).items[0];
        if (current && current.reason !== "manual") {
          throw new ConflictError({
            message: `${email} is already suppressed as a ${current.reason}, which this route may not overwrite.`,
            action:
              "Lift it with the remove route, which requires `email:suppressions:delete` — undoing a bounce, a complaint, or someone's own opt-out is a separate decision.",
            detail: `refused manual suppression over an existing ${current.reason} for ${email}`,
          });
        }

        await suppress(
          db,
          {
            email,
            // Always `manual`. See `SuppressRequest`: the other three reasons are observations the
            // system made, and a management client made none of them.
            reason: "manual",
            detail: input.detail ?? "blocked by a management client",
            environment: (c.env as { ENVIRONMENT?: string }).ENVIRONMENT ?? null,
            expiresAt,
          },
          now,
        );

        // The address is in the trail on purpose. A silent block is invisible to the person it affects
        // and to everyone else; the audit event is the only record that it happened and who asked.
        //
        // **In `metadata`, never in `resourceId`.** `auditEventView` projects `resourceId` into the
        // *listing* served under `audit:events:read`, which the audit views deliberately keep free of
        // personal data — `metadata` is held back to `audit:events:read_detail` for exactly this reason.
        // A raw recipient address in `resourceId` would let a credential holding only the everyday read
        // scope page out every address the adopter's staff has blocked, without `audit:events:read_detail`
        // and without `email:suppressions:read`. The stable row id is the correct resource handle, and it
        // is what `@pithy-sh/testers` uses.
        // Read back first, so the event can name the row rather than the person.
        const stored = await listSuppressions(db, { email, limit: 1 });
        const row = stored.items[0];

        await c.var.emit({
          action: EmailAuditActions.suppressionAdded,
          outcome: "success",
          severity: "warning",
          actorType: "control-plane",
          actorId: who.subject,
          resourceType: "email_suppression",
          resourceId: row ? String(row.id) : null,
          metadata: {
            connectionId: who.connectionId,
            email,
            reason: "manual",
            expiresAt: input.expiresAt ?? null,
          },
        });

        return c.json({ suppression: row ? suppressionView(row, now) : null } satisfies EmailSuppressResponse, 200);
      },
    );

    app.post(
      `${base}/suppressions/remove`,
      requireControlPlane(EMAIL_SUPPRESSIONS_DELETE_SCOPE),
      zValidator("json", UnsuppressRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const who = caller(c);
        const email = normalizeAddress(input.email);
        const db = suppressions(c);

        // Read before write, so the trail records *what was undone* rather than only that something
        // was. Lifting a hard bounce and lifting somebody's own unsubscribe are not the same act, and
        // once the row is gone there is nothing left to tell them apart.
        const existing = (await listSuppressions(db, { email, limit: 1 })).items[0];
        const removed = await unsuppress(db, email);

        // `resourceId` stays null and the address lives in `metadata` — see the add route above. The
        // listing view is the bulk surface and must not carry a recipient address.
        await c.var.emit({
          action: EmailAuditActions.suppressionRemoved,
          outcome: "success",
          severity: "warning",
          actorType: "control-plane",
          actorId: who.subject,
          resourceType: "email_suppression",
          resourceId: existing?.id ? String(existing.id) : null,
          metadata: {
            connectionId: who.connectionId,
            email,
            removed,
            // Null when there was nothing to remove — which is itself worth recording, because a run
            // of those is somebody probing which addresses are on the list from a credential that was
            // never granted permission to read it.
            reason: existing?.reason ?? null,
          },
        });

        return c.json({ email, removed } satisfies EmailUnsuppressResponse, 200);
      },
    );
  };
}
