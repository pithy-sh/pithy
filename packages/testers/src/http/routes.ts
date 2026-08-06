// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import type { Context, Hono } from "hono";
import { TestersAuditActions } from "../audit/actions";
import { confirmUrl, isStoreOptInUrl, optInUrl, optOutUrl, type TestersConfig } from "../config/config";
import type { TestersCohort } from "../data/cohort";
import type { NudgeKind } from "../data/enums";
import type { TestersMember } from "../data/member";
import { type TestersDatabase, testersDatabase } from "../data/tables";
import {
  TestersCohortClosedError,
  TestersCopyNotAllowedError,
  TestersInvalidTokenError,
  TestersMemberNotFoundError,
  TestersNotConfiguredError,
  TestersNudgeCooldownError,
} from "../error/errors";
import { chasedOut, mayNudge, splitByCooldown } from "../nudge/cooldown";
import { type EnqueueNudge, sendNudge } from "../nudge/send";
import { listCohorts, listMembers, listSnapshots, readCohort, requireCohort } from "../roster/read";
import {
  confirmOptIn,
  findMemberByToken,
  inviteMember,
  LIVE_STATES,
  lapseMember,
  recordAccepted,
  recordNudge,
  removeMember,
  requireMember,
  resendInvite,
  type WriteDeps,
} from "../roster/write";
import { requireAuth, TESTERS_NUDGE_SEND_SCOPE, TESTERS_ROSTER_READ_SCOPE, TESTERS_ROSTER_WRITE_SCOPE } from "./guards";
import { confirmOptOutPage, page, storePage } from "./pages";
import {
  type CohortsResponse,
  DISCLAIMER,
  type InviteResponse,
  type MembershipsResponse,
  type MembershipView,
  type NudgeDryRunResponse,
  type NudgeResponse,
  type RemoveResponse,
  type ResendResponse,
} from "./responses";
import {
  CohortsQuery,
  InviteRequest,
  NudgeRequest,
  OptInTokenParam,
  RemoveRequest,
  ResendRequest,
  StatusQuery,
} from "./schemas";
import { toCohortView } from "./view";

/**
 * The testers routes, their declared verification strategies, and what each accepts.
 *
 *   GET  /testers/confirm/:token  → "yes, I will test"           (public)          param: OptInTokenParam
 *   GET  /testers/opt-in/:token   → go join the test at the store (public)         param: OptInTokenParam
 *   GET  /testers/opt-out/:token  → withdraw from a cohort       (public)          param: OptInTokenParam
 *   GET  /testers/status          → a tester's own position      (bearer|session)  query: StatusQuery
 *   GET  /testers/cohorts         → cohort state for a dashboard (control-plane)   query: CohortsQuery
 *   POST /testers/invite          → add an address to a roster   (control-plane)   json:  InviteRequest
 *   POST /testers/resend          → send another invitation      (control-plane)   json:  ResendRequest
 *   POST /testers/remove          → take a tester off a roster   (control-plane)   json:  RemoveRequest
 *   POST /testers/nudge           → mail selected testers        (control-plane)   json:  NudgeRequest
 *
 * **The tester's journey is two links, and the order is forced by the store rather than chosen.** A
 * store opt-in page only works once the developer has added that address to the tester list, and no API
 * can do that — it is a manual step in the console. So `/confirm` asks whether they will help and
 * records their answer; the developer then adds the confirmed addresses; and `/opt-in` follows, which
 * records the strongest enrolment signal we can observe and renders the store's own link for them.
 * Sending the store link first produces `App not available`, which reads to a tester as a broken app.
 *
 * **Three routes are `public`, and all of them are deliberate.** A tester must be able to confirm or withdraw
 * from an email, on a phone, with no account — requiring a sign-in for the confirmation would mean the
 * one event the whole opt-in count rests on happened only for the subset of testers willing to create
 * an account first. Each is single-purpose and idempotent, and the token is the only gate — a random
 * value on the tester's own row, not a signature, which is what makes removing a tester a genuine
 * revocation rather than a wait for an expiry. A token nobody holds fails with the same words as an
 * expired one and as a withdrawn member's, so no route
 * is an oracle for which cohorts or testers exist.
 *
 * **Validators sit after the guards on every route line.** A validator ahead of a gate turns a 401 into
 * a 400 and tells an unauthenticated caller which requests were well-formed — on the control-plane
 * routes that is a live probe of the roster's shape.
 */

/**
 * What every route this capability mounts declares: its path, its verification strategy, and the
 * control-plane scope it checks when it has one.
 *
 * **Exported so a test can assert against the declaration rather than against a middleware count.** The
 * previous gate counted entries in `app.routes` and called anything above one "guarded" — which a bare
 * `zValidator` satisfies, so a control-plane route that lost its `requireControlPlane` would still have
 * passed. Counting proves that *something* runs before the handler; it cannot prove *what*.
 *
 * This is a declaration rather than an inference, so it can drift from the router. `routeContract.test.ts`
 * is what stops it: it checks this list against the paths Hono actually registered in both directions,
 * so a route added without an entry and an entry without a route both fail.
 */
export interface TestersRouteDeclaration {
  readonly method: "GET" | "POST";
  /** The path relative to the configured `basePath`, e.g. `/cohorts`. */
  readonly path: string;
  readonly strategy: VerificationStrategy;
  /** The control-plane scope this route checks, for a `control-plane` route. */
  readonly scope?: ControlPlaneScope;
}

/**
 * Every route, and how it is gated.
 *
 * The three `public` entries are the tester's own links. They carry no scope and no auth because the
 * token in the path is the entire credential — a tester confirming from an email has no account and
 * must not need one.
 */
export const TESTERS_ROUTES: readonly TestersRouteDeclaration[] = [
  { method: "GET", path: "/confirm/:token", strategy: "public" },
  { method: "GET", path: "/opt-in/:token", strategy: "public" },
  { method: "GET", path: "/opt-out/:token", strategy: "public" },
  { method: "POST", path: "/opt-out/:token", strategy: "public" },
  { method: "GET", path: "/status", strategy: "bearer" },
  { method: "GET", path: "/cohorts", strategy: "control-plane", scope: TESTERS_ROSTER_READ_SCOPE },
  { method: "POST", path: "/invite", strategy: "control-plane", scope: TESTERS_ROSTER_WRITE_SCOPE },
  { method: "POST", path: "/resend", strategy: "control-plane", scope: TESTERS_ROSTER_WRITE_SCOPE },
  { method: "POST", path: "/remove", strategy: "control-plane", scope: TESTERS_ROSTER_WRITE_SCOPE },
  { method: "POST", path: "/nudge", strategy: "control-plane", scope: TESTERS_NUDGE_SEND_SCOPE },
];

/** How many testers one nudge request may mail. Beyond this, the caller is running a campaign. */
const MAX_NUDGE_BATCH = 200;

/** Options `registerTestersRoutes` takes. */
export interface TestersRoutesOptions {
  /** The resolved configuration. */
  config: TestersConfig;
  /** Where the routes mount. Defaults to the config's own `basePath`. */
  basePath?: string;
  /** The clock. Injected so link expiries and stored timestamps are deterministic in tests. */
  now?: () => Date;
  /** The id source. Injected for the same reason. */
  newId?: () => string;
  /**
   * The email enqueue seam.
   *
   * Takes the request env rather than being pre-bound, because a Worker's `env` is per-request: a seam
   * captured at registration would close over whichever request happened to assemble the routes.
   */
  enqueue?: (env: Record<string, unknown>) => EnqueueNudge | undefined;
}

/**
 * Which link, if any, a nudge kind carries.
 *
 * `confirm` asks whether they will test; `store` sends them on once the developer has added them to the
 * tester list. `inactive` and `closing` carry none — inviting a tester who already joined to join again
 * reads as a mistake, and a message about engagement is not a place for a call to action.
 */
function nudgeLink(config: TestersConfig, kind: NudgeKind, member: TestersMember): string | undefined {
  if (kind === "confirm") return confirmUrl(config, member.optInToken);
  if (kind === "store") return optInUrl(config, member.optInToken);
  return undefined;
}

/** The app `DB` binding, or a stated wiring failure. */
function database(c: Context<PithyHonoEnv>): D1Database {
  const binding = (c.env as Record<string, unknown>).DB as D1Database | undefined;
  if (!binding) {
    throw new TestersNotConfiguredError({
      message: "Testers is not configured.",
      action: "Bind a D1 database named DB in wrangler.jsonc, then run pithy migrate.",
      detail: "the testers routes require a `DB` D1 binding; none was present on env",
    });
  }
  return binding;
}

/**
 * The caller's own id. `requireAuth()` has run on every route that calls this, so a null `auth` is a
 * wiring mistake rather than an unauthenticated request — hence an internal error, not a 401.
 */
function callerId(c: Context<PithyHonoEnv>): string {
  const auth = c.var.auth;
  if (!auth) throw new InternalError({ detail: "requireAuth() must run before a testers handler reads the caller." });
  return auth.userId;
}

/** The management caller. `requireControlPlane()` has run, so a null here is likewise a wiring mistake. */
function controlPlaneCaller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const caller = c.var.controlPlane;
  if (!caller) {
    throw new InternalError({ detail: "requireControlPlane() must run before a testers handler reads the caller." });
  }
  return caller;
}

/** Register the testers routes. */
export function registerTestersRoutes(options: TestersRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const config = options.config;
  const base = options.basePath ?? config.basePath;
  const clock = options.now ?? (() => new Date());
  const ids = options.newId ?? (() => crypto.randomUUID());
  const deps = (c: Context<PithyHonoEnv>): WriteDeps => ({
    db: testersDatabase(database(c)),
    now: clock(),
    newId: ids,
  });

  /**
   * A cohort that may still be written to and sent from.
   *
   * `closedAt` was stamped by `close` and then consulted by exactly one filter, so every path that did
   * not go through it carried on regardless — invite, resend and nudge all still mailed a finished
   * cohort's testers. There is no reopen, either, so a member invited onto a closed cohort sat in
   * permanent limbo: never chased, never advanced, and on the roster forever.
   */
  async function requireOpenCohort(db: TestersDatabase, cohortId: string): Promise<TestersCohort> {
    const cohort = await requireCohort(db, cohortId);
    if (cohort.closedAt !== null) {
      throw new TestersCohortClosedError({
        detail: `cohort ${cohort.id} was closed at ${cohort.closedAt.toISOString()}`,
      });
    }
    return cohort;
  }

  /**
   * Look a token up, or answer exactly as an unknown one is answered.
   *
   * The token is the whole credential, so a miss and a forgery are the same event and must produce the
   * same words. Anything else turns the public route into an oracle for which testers exist.
   *
   * `expiring` is what separates joining from leaving, and the asymmetry is deliberate — see
   * {@link memberForWithdrawal}.
   */
  async function memberFor(
    db: TestersDatabase,
    token: string,
    options: { expiring: boolean } = { expiring: true },
  ): Promise<TestersMember> {
    const member = await findMemberByToken(db, token);
    if (!member) throw new TestersInvalidTokenError({ detail: "no member holds that token" });
    // Removed and lapsed are both dead ends. Both rotate the token on the way out, so an old link
    // already fails the lookup; this is the second line of defence, and it is what stops a withdrawal
    // being undone by a replay of whatever is still sitting in the tester's inbox. Coming back requires
    // a fresh invitation, which mints a fresh token.
    if (member.state === "removed" || member.state === "lapsed") {
      throw new TestersInvalidTokenError({ detail: `member ${member.id} is ${member.state} on this cohort` });
    }
    // The configured link lifetime, enforced rather than merely declared. A token has no expiry of its
    // own — it is a row — so the age of the invitation that carried it is what bounds it. Without this
    // the config field was cross-validated against `windowDays` at deploy and then read by nothing.
    if (options.expiring) {
      const ageMs = clock().getTime() - member.lastInvitedAt.getTime();
      if (ageMs > config.optInLinkTtlDays * 86_400_000) {
        throw new TestersInvalidTokenError({
          detail: `link is ${Math.floor(ageMs / 86_400_000)} days old, past the ${config.optInLinkTtlDays}-day limit`,
        });
      }
    }
    return member;
  }

  /**
   * The same lookup for the one action that must never expire: withdrawing.
   *
   * Every other public link is an invitation to *do* something, and an invitation going stale is
   * correct. The opt-out link is the opposite — it is the tester's way out of mail this capability
   * keeps sending, and nothing bounds that outreach by `optInLinkTtlDays`. A member invited on day 0
   * who opted in on day 5 is still nudged on day 40 by the daily pass, and `lastInvitedAt` only moves
   * on a resend, so under the shared TTL their unsubscribe link would have died on day 30 while the
   * mail carrying it kept arriving. A door with no handle on the inside.
   *
   * The rest of the gate still applies. An unknown token is still unknown, and a member who already
   * left is still refused — their token was rotated on the way out, so a replayed link cannot undo the
   * withdrawal.
   */
  async function memberForWithdrawal(db: TestersDatabase, token: string): Promise<TestersMember> {
    return await memberFor(db, token, { expiring: false });
  }

  return (app) => {
    // ── public: the tester's own three links ──────────────────────────────────
    //
    // Public by design and by necessity. The confirmation is the event the opt-in count rests on, so the
    // path to it has to be as short as an email and a thumb. The token is the whole credential; nothing
    // else about the request is trusted.

    // Step one: "yes, I will test." Records consent and tells the developer to add this address to the
    // store's tester list. Nothing installs yet, and no store link is shown — it would not work.
    app.get(`${base}/confirm/:token`, zValidator("param", OptInTokenParam, validationHook), async (c) => {
      const now = clock();
      const db = testersDatabase(database(c));
      const member = await memberFor(db, c.req.valid("param").token);
      const result = await recordAccepted({ db, now, newId: ids }, member.id);

      // Only the first answer is audited. A prefetching mail client following the link three times is
      // not three events, and recording it as such would make the trail useless.
      if (result.firstTime) {
        await c.var.emit({
          action: TestersAuditActions.memberAccepted,
          outcome: "success",
          actorType: "user",
          actorId: null,
          resourceType: "testers_member",
          resourceId: member.id,
          ip: c.req.header("cf-connecting-ip"),
          userAgent: c.req.header("user-agent"),
          metadata: { cohortId: member.cohortId },
        });
      }

      return page(
        "Thank you.",
        "You are down as a tester. The developer will add you to the test, and you will get one more email with the link to join and install. Nothing to do until then.",
      );
    });

    // Step two: through to the store's own opt-in page. This is the strongest enrolment signal Pithy can
    // observe — and it is still not proof that the store accepted them, which is what `estimated` means.
    app.get(`${base}/opt-in/:token`, zValidator("param", OptInTokenParam, validationHook), async (c) => {
      const now = clock();
      const db = testersDatabase(database(c));
      const member = await memberFor(db, c.req.valid("param").token);
      const cohort = await requireCohort(db, member.cohortId);
      const result = await confirmOptIn({ db, now, newId: ids }, member.id);

      if (result.firstTime) {
        await c.var.emit({
          action: TestersAuditActions.memberOptedIn,
          outcome: "success",
          actorType: "user",
          actorId: null,
          resourceType: "testers_member",
          resourceId: member.id,
          ip: c.req.header("cf-connecting-ip"),
          userAgent: c.req.header("user-agent"),
          metadata: { cohortId: member.cohortId },
        });
      }

      // The link is rendered, never redirected to. A 302 would make this Worker a redirector, and the
      // host allowlist would then be the only thing between a bad config write and a phishing hop off a
      // domain the tester trusts *because* the adopter signed the email that brought them here. It also
      // leaves nowhere to put the two instructions below — and those are the difference between a tester
      // who joins and one who sees `App not available` and concludes the app is broken.
      if (!cohort.storeOptInUrl || !isStoreOptInUrl(cohort.storeOptInUrl)) {
        // Recording the opt-in is still right — they did their part — but we have nowhere to send them.
        return page("You're in.", "Thank you. The developer will be in touch with the link to install.");
      }
      return storePage(cohort.storeOptInUrl, cohort.targetPlatform);
    });

    // Withdrawing takes two steps, and the reason is the same one that makes the confirmation route
    // idempotent: mail clients prefetch links and security scanners follow them. A one-tap GET would let
    // a scanner silently withdraw a tester — and because withdrawing rotates their token, that is
    // irreversible without a fresh invitation. So the GET asks, and only the POST acts. Scanners do not
    // POST. This is why the opt-out is the one tester-facing action that is deliberately not one tap.
    app.get(`${base}/opt-out/:token`, zValidator("param", OptInTokenParam, validationHook), async (c) => {
      const db = testersDatabase(database(c));
      // Looked up so a dead link says so here rather than after the tester has confirmed an intent that
      // was never going to be honoured.
      await memberForWithdrawal(db, c.req.valid("param").token);
      return confirmOptOutPage(`${base}/opt-out/${c.req.valid("param").token}`);
    });

    app.post(`${base}/opt-out/:token`, zValidator("param", OptInTokenParam, validationHook), async (c) => {
      const now = clock();
      const db = testersDatabase(database(c));
      const member = await memberForWithdrawal(db, c.req.valid("param").token);
      const lapsed = await lapseMember({ db, now, newId: ids }, member.id);
      // Only a real withdrawal is audited. These routes answer unauthenticated strangers holding a
      // token, so auditing every request lets one link write unbounded rows into the adopter's trail.
      if (lapsed.firstTime) {
        await c.var.emit({
          action: TestersAuditActions.memberLapsed,
          outcome: "success",
          actorType: "user",
          actorId: null,
          resourceType: "testers_member",
          resourceId: lapsed.member.id,
          metadata: { cohortId: lapsed.member.cohortId },
        });
      }
      return page(
        "You've been removed.",
        "You will not hear from this test again. Thank you for the time you gave it.",
      );
    });

    // ── bearer | session: a tester's own view ─────────────────────────────────
    app.get(`${base}/status`, requireAuth(), zValidator("query", StatusQuery, validationHook), async (c) => {
      const now = clock();
      const d1 = database(c);
      const db = testersDatabase(d1);
      const query = c.req.valid("query");

      // A tester sees their own memberships and nothing else — not the roster, not the other testers,
      // and not the cohort's forecast. What they legitimately want to know is whether their own
      // confirmation registered and how long is left.
      const userEmail = await resolveCallerEmail(d1, callerId(c));
      if (!userEmail) return c.json({ memberships: [], disclaimer: DISCLAIMER } satisfies MembershipsResponse, 200);

      const cohorts = query.cohortId ? [await requireCohort(db, query.cohortId)] : await listCohorts(db);
      const memberships: MembershipView[] = [];
      for (const cohort of cohorts) {
        const member = (await listMembers(db, cohort.id)).find((entry) => entry.email === userEmail);
        if (!member) continue;
        // The request's own logger, namespaced to this capability. An activity read that degrades is
        // then correlated to the request that asked, rather than being an orphaned line.
        const reading = await readCohort(db, d1, cohort, config, now, c.var.log.child("testers"));
        memberships.push({
          cohortName: cohort.name,
          state: member.state,
          estimatedOptedInAt: member.optedInAt?.toISOString() ?? null,
          estimatedDaysRemaining: reading.clock.estimatedDaysRemaining,
          windowDays: cohort.windowDays,
        });
      }
      return c.json({ memberships, disclaimer: DISCLAIMER } satisfies MembershipsResponse, 200);
    });

    // ── control-plane: the dashboard's surface ────────────────────────────────
    app.get(
      `${base}/cohorts`,
      requireControlPlane(TESTERS_ROSTER_READ_SCOPE),
      zValidator("query", CohortsQuery, validationHook),
      async (c) => {
        const now = clock();
        const d1 = database(c);
        const db = testersDatabase(d1);
        const query = c.req.valid("query");

        const cohorts = query.cohortId ? [await requireCohort(db, query.cohortId)] : await listCohorts(db);
        const views = [];
        for (const cohort of cohorts) {
          const reading = await readCohort(db, d1, cohort, config, now, c.var.log.child("testers"));
          // The latest snapshot is read even when the series is not, because it carries the
          // precomputed trend — recomputing the deltas here would let the card and the chart disagree.
          const snapshots = await listSnapshots(db, cohort.id, query.trend ? query.trendDays : 1);
          views.push(
            toCohortView(
              reading,
              config,
              {
                includeMembers: query.members,
                snapshots: query.trend ? snapshots : [],
                latest: snapshots[snapshots.length - 1],
              },
              now,
            ),
          );
        }

        return c.json(
          {
            cohorts: views,
            modelVersion: config.modelVersion,
            generatedAt: now.toISOString(),
            disclaimer: DISCLAIMER,
          } satisfies CohortsResponse,
          200,
        );
      },
    );

    app.post(
      `${base}/invite`,
      requireControlPlane(TESTERS_ROSTER_WRITE_SCOPE),
      zValidator("json", InviteRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        const write = deps(c);
        const cohort = await requireOpenCohort(write.db, input.cohortId);

        // The route schema bounds the name at its own ceiling; this enforces the project's, which may
        // be tighter. Same rule as the nudge copy below, and for the same reason: `maxNameLength` was
        // declared, bounded, defaulted and described, and read by nothing at all — so an adopter who
        // set it to 40 to keep their roster renderable still had 120 accepted.
        if (input.name && input.name.length > config.maxNameLength) {
          throw new ValidationError({
            message: "That name is longer than this deployment allows.",
            action: `Keep it under ${config.maxNameLength} characters.`,
            detail: `name was ${input.name.length}, limit ${config.maxNameLength}`,
          });
        }

        const { member, created } = await inviteMember(write, {
          cohortId: cohort.id,
          email: input.email,
          name: input.name ?? null,
          maxRosterSize: cohort.maxRosterSize,
        });

        let jobId: string | null = null;
        if (input.sendInvitation) {
          const enqueue = options.enqueue?.(c.env as Record<string, unknown>);
          if (!enqueue) {
            throw new TestersNotConfiguredError({
              message: "Invitations cannot be sent yet.",
              action: "Add `email(...)` to this Worker's capabilities — invitations are enqueued through it.",
              detail: "the email capability was not composed, so no enqueue seam is bound",
            });
          }
          const sent = await sendNudge(enqueue, {
            member,
            kind: "confirm",
            supplied: undefined,
            ctaUrl: confirmUrl(config, member.optInToken),
            optOutUrl: optOutUrl(config, member.optInToken),
          });
          await recordNudge(write, {
            memberId: member.id,
            nudgeKind: "confirm",
            jobId: sent.jobId,
            copySource: "default",
          });
          jobId = sent.jobId;
        }

        await c.var.emit({
          action: TestersAuditActions.memberInvited,
          outcome: "success",
          severity: "warning",
          actorType: "control-plane",
          actorId: caller.subject,
          resourceType: "testers_member",
          resourceId: member.id,
          metadata: { connectionId: caller.connectionId, cohortId: cohort.id, email: member.email, created, jobId },
        });

        return c.json(
          {
            member: { id: member.id, email: member.email, state: member.state },
            created,
            jobId,
          } satisfies InviteResponse,
          200,
        );
      },
    );

    app.post(
      `${base}/resend`,
      requireControlPlane(TESTERS_ROSTER_WRITE_SCOPE),
      zValidator("json", ResendRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        const write = deps(c);

        // The cooldown is enforced here too. It is documented as applying on every path, and a resend
        // that bypassed it would be the obvious way to mail one tester repeatedly — the exact thing the
        // guard exists to prevent, reachable by anyone holding the write scope.
        const before = await requireMember(write.db, input.memberId);
        // Resend names a member rather than a cohort, so the cohort comes from the member's own row.
        await requireOpenCohort(write.db, before.cohortId);
        // A resend is outreach, so it obeys the same consent rule every other send does. Without this,
        // the one path that skipped `selectForNudge` could still mail someone who had withdrawn.
        if (!LIVE_STATES.includes(before.state)) {
          throw new TestersMemberNotFoundError({
            detail: `member ${before.id} is ${before.state} and cannot be re-invited`,
          });
        }
        // The chase cap, on this path too. It was read only by the daily pass, so a dashboard holding
        // the write scope could keep chasing somebody who had stopped answering — every three days,
        // for the life of the cohort, which is exactly what the cap exists to prevent.
        if (chasedOut(before)) {
          throw new TestersNudgeCooldownError({
            message: "That tester has stopped answering, so we have stopped chasing them.",
            action: "They stay on the roster. Remove them and invite a replacement if you need the place.",
            detail: `member ${before.id} has ${before.nudgeCount} unanswered nudges`,
          });
        }
        if (!mayNudge(before, config.nudges.cooldownHours, clock())) {
          await c.var.emit({
            action: TestersAuditActions.nudgeThrottled,
            outcome: "denied",
            actorType: "control-plane",
            actorId: caller.subject,
            resourceType: "testers_member",
            resourceId: before.id,
            metadata: { connectionId: caller.connectionId, cohortId: before.cohortId },
          });
          throw new TestersNudgeCooldownError({
            detail: `member ${before.id} was last nudged at ${before.lastNudgedAt?.toISOString() ?? "never"}`,
          });
        }

        const member = await resendInvite(write, input.memberId);

        const enqueue = options.enqueue?.(c.env as Record<string, unknown>);
        if (!enqueue) {
          throw new TestersNotConfiguredError({
            message: "Invitations cannot be sent yet.",
            action: "Add `email(...)` to this Worker's capabilities — invitations are enqueued through it.",
            detail: "the email capability was not composed, so no enqueue seam is bound",
          });
        }
        const sent = await sendNudge(enqueue, {
          member,
          kind: "confirm",
          supplied: undefined,
          ctaUrl: confirmUrl(config, member.optInToken),
          optOutUrl: optOutUrl(config, member.optInToken),
        });
        await recordNudge(write, {
          memberId: member.id,
          nudgeKind: "confirm",
          jobId: sent.jobId,
          copySource: "default",
        });

        await c.var.emit({
          action: TestersAuditActions.memberReinvited,
          outcome: "success",
          actorType: "control-plane",
          actorId: caller.subject,
          resourceType: "testers_member",
          resourceId: member.id,
          metadata: { connectionId: caller.connectionId, cohortId: member.cohortId, jobId: sent.jobId },
        });
        // Id, not address — the same rule the nudge preview below states and for the same reason. The
        // three scopes are separated so a credential may mail or manage a roster it was never granted
        // permission to read, and echoing the address back on every write turned a list of ids (which
        // the dry-run hands out by design) into a list of real people's email addresses.
        return c.json({ member: { id: member.id }, jobId: sent.jobId } satisfies ResendResponse, 200);
      },
    );

    app.post(
      `${base}/remove`,
      requireControlPlane(TESTERS_ROSTER_WRITE_SCOPE),
      zValidator("json", RemoveRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        const write = deps(c);
        const member = await removeMember(write, input.memberId, input.reason);
        await c.var.emit({
          action: TestersAuditActions.memberRemoved,
          outcome: "success",
          severity: "warning",
          actorType: "control-plane",
          actorId: caller.subject,
          resourceType: "testers_member",
          resourceId: member.id,
          metadata: { connectionId: caller.connectionId, cohortId: member.cohortId, reason: input.reason ?? null },
        });
        // Id and state, not the address. See the resend route above.
        return c.json({ member: { id: member.id, state: member.state } } satisfies RemoveResponse, 200);
      },
    );

    app.post(
      `${base}/nudge`,
      requireControlPlane(TESTERS_NUDGE_SEND_SCOPE),
      zValidator("json", NudgeRequest, validationHook),
      async (c) => {
        const input = c.req.valid("json");
        const caller = controlPlaneCaller(c);
        const now = clock();
        const write = deps(c);
        const cohort = await requireOpenCohort(write.db, input.cohortId);

        const suppliedCopy = input.subject !== undefined || input.body !== undefined;
        if (suppliedCopy && !config.nudges.allowCopyOverride) {
          await c.var.emit({
            action: TestersAuditActions.copyRejected,
            outcome: "denied",
            severity: "warning",
            actorType: "control-plane",
            actorId: caller.subject,
            resourceType: "testers_cohort",
            resourceId: cohort.id,
            metadata: { connectionId: caller.connectionId },
          });
          throw new TestersCopyNotAllowedError({
            detail: "nudges.allowCopyOverride is false, and the request carried a subject or body",
          });
        }

        // The route schema bounds copy at its own ceiling; this enforces the project's, which may be
        // tighter. Declaring a limit and never reading it is worse than not having one.
        if (input.subject && input.subject.length > config.nudges.maxSubjectLength) {
          throw new TestersCopyNotAllowedError({
            message: "That subject is longer than this deployment allows.",
            action: `Keep it under ${config.nudges.maxSubjectLength} characters.`,
            detail: `subject was ${input.subject.length}, limit ${config.nudges.maxSubjectLength}`,
          });
        }
        if (input.body && input.body.length > config.nudges.maxBodyLength) {
          throw new TestersCopyNotAllowedError({
            message: "That message is longer than this deployment allows.",
            action: `Keep it under ${config.nudges.maxBodyLength} characters.`,
            detail: `body was ${input.body.length}, limit ${config.nudges.maxBodyLength}`,
          });
        }

        // The same readiness test the daily pass and the opt-in route apply. Without it the dashboard's
        // own send button was the one path that could mail the join link for a cohort with no usable
        // store URL — and following that link runs `confirmOptIn`, so the opt-in estimate climbs on
        // testers who were never enrolled with Google. The pass calls that the worst failure this
        // capability has; the route must not be the exception to it.
        if (input.kind === "store" && !(cohort.storeOptInUrl && isStoreOptInUrl(cohort.storeOptInUrl))) {
          throw new TestersNotConfiguredError({
            message: "This cohort has no store opt-in link, so there is nothing to send.",
            action: "Set one with `pithy testers create --store-url`, then send again.",
            detail: `cohort ${cohort.id} storeOptInUrl is ${cohort.storeOptInUrl === null ? "null" : "not a store URL"}`,
          });
        }

        const roster = await listMembers(write.db, cohort.id);
        const candidates = selectForNudge(roster, input.kind, input.memberIds);
        // Cooled and unreachable testers are removed *before* the batch cap, not after. Slicing first
        // spent the two hundred places on whoever sorted earliest — including testers who were only
        // going to be dropped for cooling anyway — so on a roster over the cap the tail was never
        // reached on any run, however often the send was repeated.
        const split = splitByCooldown(candidates, config.nudges.cooldownHours, now);
        const sendable = split.eligible.slice(0, MAX_NUDGE_BATCH);
        // Reported, not silent. The request schema admits 500 ids and a roster may hold far more, so
        // exceeding the batch is a designed-for case rather than an edge — and a member dropped by the
        // cap lands in no bucket at all, so without this a caller could not tell "everyone eligible was
        // mailed" from "the first two hundred were". That is the same partial success the empty send
        // below refuses to report as success.
        const truncated = split.eligible.length - sendable.length;

        if (input.dryRun) {
          return c.json(
            {
              dryRun: true,
              // Ids, not addresses. A caller holding only `testers:nudge:send` can mail the roster but
              // was never granted permission to read it, and a preview returning every eligible
              // tester's email would hand them exactly what `testers:roster:read` exists to gate.
              wouldSend: sendable.map((member) => ({ id: member.id })),
              cooling: split.cooling.length,
              unreachable: split.unreachable.length,
              chasedOut: split.chasedOut.length,
              truncated,
            } satisfies NudgeDryRunResponse,
            200,
          );
        }

        // Nothing sent is not a partial success. A response that reported an empty send as a success
        // would render in a dashboard as "sent" and the developer would never chase it.
        if (split.eligible.length === 0) {
          await c.var.emit({
            action: TestersAuditActions.nudgeThrottled,
            outcome: "denied",
            actorType: "control-plane",
            actorId: caller.subject,
            resourceType: "testers_cohort",
            resourceId: cohort.id,
            metadata: {
              connectionId: caller.connectionId,
              selected: candidates.length,
              cooling: split.cooling.length,
              unreachable: split.unreachable.length,
            },
          });
          throw new TestersNudgeCooldownError({
            detail: `${split.cooling.length} cooling, ${split.unreachable.length} unreachable, 0 eligible`,
          });
        }

        const enqueue = options.enqueue?.(c.env as Record<string, unknown>);
        if (!enqueue) {
          throw new TestersNotConfiguredError({
            message: "Nudges cannot be sent yet.",
            action: "Add `email(...)` to this Worker's capabilities — nudges are enqueued through it.",
            detail: "the email capability was not composed, so no enqueue seam is bound",
          });
        }

        const sent = [];
        for (const member of sendable) {
          const result = await sendNudge(enqueue, {
            member,
            kind: input.kind,
            supplied: suppliedCopy ? { subject: input.subject, body: input.body } : undefined,
            // Only the confirmation nudge carries a link. Attaching one to an inactivity nudge would
            // invite a tester who has already confirmed to confirm again, which reads as a mistake.
            // `confirm` carries the "will you test?" link; `store` carries the one that leads to the
            // store. The other two kinds carry no link at all — a nudge about inactivity that invited
            // someone to confirm again would read as a mistake.
            ctaUrl: nudgeLink(config, input.kind, member),
            optOutUrl: optOutUrl(config, member.optInToken),
          });
          await recordNudge(write, {
            memberId: member.id,
            nudgeKind: input.kind,
            jobId: result.jobId,
            copySource: result.copy.source,
          });
          sent.push({ memberId: member.id, jobId: result.jobId });
        }

        await c.var.emit({
          action: TestersAuditActions.nudgeSent,
          outcome: "success",
          severity: "warning",
          actorType: "control-plane",
          actorId: caller.subject,
          resourceType: "testers_cohort",
          resourceId: cohort.id,
          metadata: {
            connectionId: caller.connectionId,
            kind: input.kind,
            sent: sent.length,
            skippedCooling: split.cooling.length,
            skippedUnreachable: split.unreachable.length,
            skippedChasedOut: split.chasedOut.length,
            truncated,
            // The provenance, never the words. A trail that quoted every nudge would be a copy of every
            // email ever sent, sitting in a queryable table.
            copySource: suppliedCopy ? "supplied" : "default",
          },
        });

        return c.json(
          {
            sent,
            skipped: {
              cooling: split.cooling.length,
              unreachable: split.unreachable.length,
              chasedOut: split.chasedOut.length,
              truncated,
            },
            copySource: suppliedCopy ? "supplied" : "default",
          } satisfies NudgeResponse,
          200,
        );
      },
    );
  };
}

/**
 * Which testers a nudge kind targets when the caller names none.
 *
 * Naming ids explicitly always wins; the defaults exist so `POST /testers/nudge {"kind":"confirm"}` does
 * the obvious thing without asking anyone to assemble a list by hand.
 */
export function selectForNudge(
  roster: readonly TestersMember[],
  kind: NudgeKind,
  memberIds: readonly string[] | undefined,
): TestersMember[] {
  if (memberIds && memberIds.length > 0) {
    const wanted = new Set(memberIds);
    // Naming an id selects, it does not override. Consent and removal are server-side facts exactly as
    // the cooldown is, so a caller cannot mail someone who opted out by pointing at them directly —
    // which is the one message this capability must never send.
    // State-appropriate for the kind, not merely live. Naming an `invited` member on a `store` send
    // would mail the join link to somebody who has not agreed to test and is certainly not on the Play
    // tester list — the store page only works for an address the developer has already added by hand.
    const found = roster.filter(
      (member) => wanted.has(member.id) && LIVE_STATES.includes(member.state) && eligibleForKind(member, kind),
    );
    if (found.length === 0) {
      throw new TestersMemberNotFoundError({
        detail: `none of the ${memberIds.length} named members are on this cohort in a live state`,
      });
    }
    return found;
  }
  return roster.filter((member) => eligibleForKind(member, kind));
}

/**
 * Whether this tester is in a state that makes this kind of nudge sensible.
 *
 * Applied to a named-id selection as well as to a kind-selects-them one. Naming an id selects; it does
 * not override — the same rule the live-state filter above already enforces, and for the same reason.
 * Mailing the store link to an `invited` member sends the join page to somebody who has not agreed to
 * test and whom the developer has certainly not added to the Play tester list, so the page answers
 * `App not available` and the tester concludes the app is broken.
 */
function eligibleForKind(member: TestersMember, kind: NudgeKind): boolean {
  switch (kind) {
    case "confirm":
      return member.state === "invited";
    case "store":
      // The same population the daily pass sends the store link to. Without this the kind selected
      // nobody and the handler raised a cooldown error, which reads as "everyone is cooling down" when
      // the truth is "this kind selects no one".
      return member.state === "accepted";
    case "inactive":
    case "closing":
      return member.state === "opted_in";
    default:
      return false;
  }
}

/**
 * The caller's own email address, from `@pithy-sh/auth`.
 *
 * A guarded dynamic import, because auth is an optional peer: a project with no sign-in has no
 * `/status` route worth serving, and the honest answer there is an empty membership list rather than a
 * failure to boot.
 */
async function resolveCallerEmail(d1: D1Database, userId: string): Promise<string | null> {
  try {
    const { authDatabase } = await import("@pithy-sh/auth/src/data/tables");
    const row = await authDatabase(d1)
      .selectFrom("pithyAuthUsers")
      .select(["email"])
      .where("id", "=", userId)
      .executeTakeFirst();
    return row ? String(row.email).toLowerCase() : null;
  } catch {
    return null;
  }
}
