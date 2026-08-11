// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import {
  requireAuth,
  SUPPORT_THREADS_ARCHIVE_SCOPE,
  SUPPORT_THREADS_FLAG_SCOPE,
  SUPPORT_THREADS_READ_SCOPE,
  SUPPORT_THREADS_RECLASSIFY_SCOPE,
  SUPPORT_THREADS_REPLY_SCOPE,
} from "./guards";
import {
  archiveConversation,
  type HandlerDeps,
  listInbox,
  listMyThreads,
  listReplies,
  readConversation,
  readMyThread,
  reclassifyConversation,
  replyToConversation,
  submitFeedbackRequest,
  updateFlags,
} from "./handlers";
import type { SupportRepliesResponse } from "./responses";
import {
  ArchiveThreadInput,
  FlagsInput,
  ListThreadsQuery,
  MyThreadsQuery,
  RepliesQuery,
  ReplyInput,
  SubmitFeedbackInput,
  ThreadIdParam,
} from "./schemas";

/**
 * The support routes, their verification strategies, and what each accepts:
 *
 *   GET  /support/threads               → the inbox     (control-plane: support:threads:read)       query: ListThreadsQuery
 *   GET  /support/threads/:id           → one thread    (control-plane: support:threads:read)       param: ThreadIdParam
 *   POST /support/threads/:id/archive   → done/reopen   (control-plane: support:threads:archive)    param + json
 *   POST /support/threads/:id/reply     → answer        (control-plane: support:threads:reply)      param + json
 *   POST /support/threads/:id/reclassify→ re-run model  (control-plane: support:threads:reclassify) param
 *   POST /support/threads/:id/flags     → read/snooze   (control-plane: support:threads:flag)       param + json
 *   GET  /support/replies               → canned copy   (control-plane: support:threads:read)       query: RepliesQuery
 *
 *   POST /support/feedback              → write in      (bearer/session + same-origin)              json: SubmitFeedbackInput
 *   GET  /support/feedback              → my requests   (bearer/session)                            query: MyThreadsQuery
 *   GET  /support/feedback/:id          → one of mine   (bearer/session)                            param: ThreadIdParam
 *
 * **Two surfaces, two gates, and they never stack.** The management routes answer to a control-plane
 * credential the adopter issued, and with the seam uncomposed every one denies with
 * `controlplane/not_connected` — the correct failure for an inbox holding other people's private
 * correspondence. The `feedback` routes answer to the adopter's own signed-in user, and with no auth
 * capability composed `c.var.auth` is null and every one denies. A control-plane caller holds no
 * session by design and can never satisfy `requireAuth()`; a user's session confers no scope. See
 * `guards.ts`.
 *
 * **`requireSameOrigin()` is on the submission route and on neither read.** Cookie-mode sessions make a
 * mutating route CSRF-reachable, and this one writes into a support inbox under a real customer's name
 * — a forged submission is somebody else's words attributed to them, in the one place an operator
 * treats attribution as proven. The reads are GETs and carry no such risk. A bearer caller is
 * CSRF-exempt, and that exemption belongs to the gate `@pithy-sh/auth` publishes rather than to
 * anything decided here.
 *
 * **Every response has an exported schema**, in `responses.ts`. Each handler's return type is
 * `z.output` of its envelope, so `c.json(await handler(...))` carries the contract without a cast — and
 * a management client imports the same object and validates with it rather than hand-writing a mirror
 * that drifts.
 *
 * The validators sit **after** the gate on every line. A validator ahead of it turns a 401 into a
 * 400 and tells an unverified caller which requests were well-formed — and on this surface that is a
 * live oracle for the shape of an adopter's support tooling.
 */

/** How the support sub-router is built. */
export interface SupportRoutesOptions {
  /** The path the routes mount under. Defaults to `/support`. */
  basePath?: string;
  /**
   * Whether to mount the in-app submission routes. Defaults to true, matching `submission.enabled`.
   *
   * Not mounting is deliberate rather than a guard inside the handlers: a route that is not served
   * answers 404, and 404 is the honest answer. A 403 would say "this exists and you may not use it" to
   * a caller asking about a feature this deployment does not have.
   */
  submission?: boolean;
  /** Resolve handler deps from the request context. */
  resolveDeps: (c: Context<PithyHonoEnv>) => Promise<HandlerDeps>;
}

/**
 * The verified management client behind a control-plane call.
 *
 * `requireControlPlane()` has run on every route, so `c.var.controlPlane` is populated by the time a
 * handler reads it. The throw is a programming-error guard, not a runtime path: reaching it would
 * mean a route was mounted without its gate, which is the one mistake this whole file is arranged to
 * make impossible.
 */
function viewer(c: Context<PithyHonoEnv>): string {
  const subject = c.var.controlPlane?.subject;
  if (!subject) {
    throw new InternalError({
      message: "Support could not identify the management caller.",
      detail: "requireControlPlane() must run before a support handler reads the caller.",
    });
  }
  return subject;
}

/**
 * The signed-in user behind an in-app submission.
 *
 * `requireAuth()` has run on every route that calls this, so `c.var.auth` is populated by the time a
 * handler reads it. The throw is a programming-error guard rather than a runtime path — the mirror of
 * {@link viewer}, and the reason neither handler ever has to think about an absent caller.
 */
function submitter(c: Context<PithyHonoEnv>): string {
  const auth = c.var.auth;
  if (!auth) {
    throw new InternalError({
      message: "Support could not identify the signed-in caller.",
      detail: "requireAuth() must run before a support submission handler reads the submitter.",
    });
  }
  return auth.userId;
}

/** Register the support sub-router. Returned as the capability's `routes` hook. */
export function registerSupportRoutes(options: SupportRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/support";
  const resolve = options.resolveDeps;
  const submission = options.submission ?? true;

  return (app) => {
    app.get(
      `${base}/threads`,
      requireControlPlane(SUPPORT_THREADS_READ_SCOPE),
      zValidator("query", ListThreadsQuery, validationHook),
      async (c) => c.json(await listInbox(await resolve(c), c.req.valid("query"), viewer(c))),
    );

    app.get(
      `${base}/replies`,
      requireControlPlane(SUPPORT_THREADS_READ_SCOPE),
      zValidator("query", RepliesQuery, validationHook),
      async (c) =>
        c.json({ replies: listReplies(await resolve(c), c.req.valid("query")) } satisfies SupportRepliesResponse),
    );

    app.get(
      `${base}/threads/:id`,
      requireControlPlane(SUPPORT_THREADS_READ_SCOPE),
      zValidator("param", ThreadIdParam, validationHook),
      async (c) => c.json(await readConversation(await resolve(c), c.req.valid("param").id)),
    );

    app.post(
      `${base}/threads/:id/archive`,
      requireControlPlane(SUPPORT_THREADS_ARCHIVE_SCOPE),
      zValidator("param", ThreadIdParam, validationHook),
      zValidator("json", ArchiveThreadInput, validationHook),
      async (c) =>
        c.json(await archiveConversation(await resolve(c), c.req.valid("param").id, c.req.valid("json"), viewer(c))),
    );

    app.post(
      `${base}/threads/:id/reply`,
      requireControlPlane(SUPPORT_THREADS_REPLY_SCOPE),
      zValidator("param", ThreadIdParam, validationHook),
      zValidator("json", ReplyInput, validationHook),
      async (c) =>
        c.json(
          await replyToConversation(await resolve(c), c.req.valid("param").id, c.req.valid("json"), viewer(c)),
          201,
        ),
    );

    app.post(
      `${base}/threads/:id/reclassify`,
      requireControlPlane(SUPPORT_THREADS_RECLASSIFY_SCOPE),
      zValidator("param", ThreadIdParam, validationHook),
      async (c) => c.json(await reclassifyConversation(await resolve(c), c.req.valid("param").id, viewer(c))),
    );

    app.post(
      `${base}/threads/:id/flags`,
      requireControlPlane(SUPPORT_THREADS_FLAG_SCOPE),
      zValidator("param", ThreadIdParam, validationHook),
      zValidator("json", FlagsInput, validationHook),
      async (c) => c.json(await updateFlags(await resolve(c), c.req.valid("param").id, c.req.valid("json"), viewer(c))),
    );

    if (!submission) return;

    // The one route on this capability a customer calls directly. `requireAuth()` first, then the CSRF
    // gate, then the contract — a validator ahead of either would turn a 401 into a 400 and tell an
    // unauthenticated caller which submissions were well-formed.
    app.post(
      `${base}/feedback`,
      requireAuth(),
      requireSameOrigin(),
      zValidator("json", SubmitFeedbackInput, validationHook),
      async (c) => c.json(await submitFeedbackRequest(await resolve(c), c.req.valid("json"), submitter(c)), 201),
    );

    app.get(`${base}/feedback`, requireAuth(), zValidator("query", MyThreadsQuery, validationHook), async (c) =>
      c.json(await listMyThreads(await resolve(c), c.req.valid("query"), submitter(c))),
    );

    app.get(`${base}/feedback/:id`, requireAuth(), zValidator("param", ThreadIdParam, validationHook), async (c) =>
      c.json(await readMyThread(await resolve(c), c.req.valid("param").id, submitter(c))),
    );
  };
}
