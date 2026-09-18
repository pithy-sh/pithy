// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emitAfterRequest, emitProviderAccountChanged, emitProviderUnavailable } from "../audit/emit";
import {
  type AuthEmailDelivery,
  claimAccountRemoval,
  markSessionEnded,
  messageDeliveryDuring,
  removalWasClaimed,
  sessionEndedDuring,
} from "../audit/evidence";
import { KIT_SESSION_FIELDS, KIT_USER_FIELDS } from "../data/kitFields";
import type { AuthDatabase } from "../data/tables";
import { parseDeviceMeta, registerDevice } from "../device/registry";
import { PROVIDER_CHANGE_FRESH_AGE_SECONDS } from "../http/providerFreshness";
import { refuseUnsafeProfile, sanitizeProfile } from "../profile/profile";
import { defaultGithubUserInfo, type GithubUserInfoResolver } from "./githubUserInfo";
import { kitPlugins } from "./plugins";
import {
  providerUnavailable,
  type ResolvedProviders,
  type SocialProviderId,
  unavailableProviderFor,
} from "./providers";

/**
 * Build the `socialProviders` block from whichever provider credentials were resolved. Exported so the
 * per-provider branch matrix is unit-testable without constructing a Better Auth instance — it reads
 * only the resolved credentials on `deps`, never the database.
 *
 * **Only a `ready` provider is registered.** A `disabled` one never was; an `unresolvable` one is the
 * change #381 made, and it is what keeps magic link and OTP working while one credential is unreadable.
 * The narrowing is the type's doing rather than this function's discipline — `deps.google.credentials`
 * does not exist until `state === "ready"` has been established.
 */
/**
 * One provider's sign-up policy, in Better Auth's spelling.
 *
 * **Applied by every provider block, because the toggle is declared on every provider.** `allowSignUp`
 * lives on the shared `ProviderToggle`, so an adopter can write it for google, apple or facebook exactly
 * as readily as for github — and a policy the config accepts, describes and type-checks while the
 * instance ignores it is worse than one that was never offered. It shipped github-only for one round;
 * the reason nobody noticed is that github is the provider anybody testing this would try.
 *
 * Permitted is the **absence** of the key rather than `disableSignUp: false`, so the default path asserts
 * nothing and Better Auth's own default stands. It reads this off `provider.options` at
 * `callback.mjs:229`.
 */
function signUpOption(allowed: boolean): { disableSignUp?: true } {
  return allowed ? {} : { disableSignUp: true };
}

export function socialProviders(deps: AuthInstanceDeps): Record<string, unknown> | undefined {
  const providers: Record<string, unknown> = {};
  if (deps.google.state === "ready") {
    providers.google = {
      clientId: deps.google.credentials.clientId,
      clientSecret: deps.google.credentials.clientSecret,
      accessType: "offline",
      prompt: "select_account consent",
      ...signUpOption(deps.providerSignUp.google),
    };
  }
  if (deps.apple.state === "ready") {
    const apple = deps.apple.credentials;
    providers.apple = {
      clientId: apple.clientId,
      clientSecret: apple.clientSecret,
      ...(apple.appBundleIdentifier ? { appBundleIdentifier: apple.appBundleIdentifier } : {}),
      ...signUpOption(deps.providerSignUp.apple),
    };
  }
  if (deps.facebook.state === "ready") {
    // Assert Facebook's email as verified. Facebook confirms a user's email before it will return it,
    // and Better Auth validates the access token against this app before trusting the `/me` profile —
    // so the email is genuinely the authenticated user's, verified by Facebook (the same trust Google
    // and Apple get). Better Auth otherwise defaults Facebook's `emailVerified` to `false` (its OAuth
    // response carries no `email_verified` claim, and the Graph API exposes no such field), which would
    // wrongly route every Facebook sign-in through verify-to-link. `mapProfileToUser` overrides only
    // Facebook's own email; Facebook stays out of `trustedProviders`.
    providers.facebook = {
      clientId: deps.facebook.credentials.clientId,
      clientSecret: deps.facebook.credentials.clientSecret,
      scope: ["email"],
      mapProfileToUser: () => ({ emailVerified: true }),
      ...signUpOption(deps.providerSignUp.facebook),
    };
  }
  if (deps.github.state === "ready") {
    // `user:email` (Better Auth's default GitHub scope, requested explicitly here) lets the provider
    // read the primary email's verified flag from the GitHub emails API — the signal account-linking
    // gates on. GitHub is not a trusted provider, so an unverified GitHub email never auto-links.
    providers.github = {
      clientId: deps.github.credentials.clientId,
      clientSecret: deps.github.credentials.clientSecret,
      scope: ["user:email"],
      // The kit's own resolution rule, or the adopter's. Better Auth's stock resolver keeps the primary
      // and falls back to `emails[0]`, and matches no existing user by any other address — so a GitHub
      // whose primary is not the sign-up address minted a second, empty user (#554).
      getUserInfo: deps.resolveGithubUserInfo ?? defaultGithubUserInfo(),
      ...signUpOption(deps.providerSignUp.github),
    };
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

/**
 * The seeding guard: a new account may be created only for an email a provider has **verified**.
 *
 * Passwordless sign-up (magic link / OTP) always creates `emailVerified: true`; a social sign-up
 * carries the provider's own flag. Refusing an unverified-email create closes the rival-account
 * seeding vector — otherwise an untrusted provider (e.g. a GitHub account holding an *unverified*
 * email at someone else's address) could mint a row that a later magic-link login by the true owner
 * would inherit. Returns `true` when the create must be refused. Account *linking* into an existing
 * user is handled separately by Better Auth's `trustedProviders` gate; this only guards creation.
 */
export function isUnverifiedSignup(user: { emailVerified?: boolean | null }): boolean {
  return user.emailVerified !== true;
}

/**
 * Refuse a write whose `name` or `image` is not a shape this kit will render, with a 400 naming the
 * field.
 *
 * The decision is `../profile/profile.ts`'s and is pure; this is the half that needs `APIError`, which
 * is what turns a refusal into a 400 instead of a row that throws on every later read. That failure
 * mode is the one `../data/kitFields.ts` already documents for `locale`: a bad value written once makes
 * the *listing* fail for every operator rather than only for its author.
 */
function refuseUnsafeProfileFields(user: { name?: unknown; image?: unknown }): void {
  const refusal = refuseUnsafeProfile(user);
  if (!refusal) return;
  throw new APIError("BAD_REQUEST", { code: "INVALID_PROFILE_FIELD", message: refusal.message });
}

/** The endpoint context a database hook is handed, narrowed to the two things attribution needs. */
interface HookContext {
  headers?: Headers;
  context?: { session?: { user?: { id?: string } } | null };
}

/**
 * Who caused a row change, read from the endpoint context Better Auth hands a database hook.
 *
 * **The context is absent as often as it is present, and that absence is information.** A hook reached
 * from `/unlink-account` gets the full endpoint context with the caller's session on it; one reached
 * from a script, a queue consumer or a migration calling `internalAdapter` outside any dispatch gets
 * `null`. So `fromRequest` distinguishes *nobody was calling* from *a caller with no session*, which is
 * the difference between `system` and `anonymous` in the row — and it is what stops a cascade from being
 * written as the account owner's own action, which is what #627's first cut did.
 *
 * **It is not, and must not be read as, "the cascade is `system`".** `getWithHooks` resolves its context
 * from `getCurrentAuthContext()`, which is async-scoped to the dispatch, so a cascade reached through an
 * endpoint arrives here with that endpoint's session and headers — and the operator who drove it is
 * named as the actor of every row it writes, correctly. What this function reads is who was calling, and
 * a cascade is not a special kind of caller.
 */
function callerOf(ctx: HookContext | null | undefined): {
  callerId: string | null;
  fromRequest: boolean;
  headers: Headers | undefined;
} {
  return {
    callerId: ctx?.context?.session?.user?.id ?? null,
    fromRequest: Boolean(ctx),
    headers: ctx?.headers,
  };
}

/**
 * What the instance hands to Pithy's email seam to deliver. The route never sends inline — the hook
 * enqueues an `@pithy-sh/email` job (`magicLink`/`otp` template) which a Workflow delivers.
 */
export type AuthEmailMessage =
  | { to: string; template: "magicLink"; token: string; url: string }
  | { to: string; template: "otp"; code: string };

/**
 * The email-delivery seam: enqueue (never send inline). Injected so the instance stays I/O-agnostic.
 *
 * **It answers what happened, and that answer is the evidence behind two audit events.** Returning
 * `Promise<void>` made the seam structurally blind: `auth/magic_link_sent` and `auth/otp_sent` claim a
 * message, `@pithy-sh/email` decides whether there is one, and nothing carried that decision back — so a
 * recipient the suppression list withheld, and an enqueue that threw, both wrote `outcome: "success"`
 * (#627). {@link AuthEmailDelivery} is the narrowest thing that closes it: queued, withheld with a
 * reason, or failed. The instance still knows nothing about email infrastructure — `withheld` and
 * `failed` are facts about a message, not about a binding.
 *
 * **Internal.** It is produced by `../email/send.ts`'s `makeSendAuthEmail`, consumed by
 * `./plugins.ts`, and wired by `../http/resolve.ts` from the composed email capability's own `enqueue`.
 * An adopter never supplies one — `AuthWiring.enqueueEmail` is filled by `compose` — and it is not
 * exported from `../index.ts`, so widening the return type breaks nothing they can hold.
 */
export type SendAuthEmail = (message: AuthEmailMessage) => Promise<AuthEmailDelivery>;

/**
 * Everything the Better-Auth instance needs, resolved per invocation from config + request env.
 *
 * Generic in the adopter's plugin tuple so the composed instance's type — and therefore its `$Infer`
 * surface — reflects what was actually composed rather than only the kit's own.
 */
export interface AuthInstanceDeps<Plugins extends readonly BetterAuthPlugin[] = readonly BetterAuthPlugin[]>
  extends ResolvedProviders {
  /** The shared Kysely over the `pithy_auth_*` tables (carries `CamelCasePlugin`). */
  db: AuthDatabase;
  /** The Better-Auth signing/encryption secret, sourced from `@pithy-sh/secrets`. */
  secret: string;
  /** The public base URL of this environment's auth worker (no trailing slash). */
  baseURL: string;
  /** The mount path; must equal the Hono route the handler is mounted under. */
  basePath: string;
  /** Web origins and mobile deep-link schemes allowed as OAuth/redirect targets and for CSRF origin checks. */
  trustedOrigins: string[];
  // The four social providers arrive from `ResolvedProviders` — each one `disabled`, `ready` with its
  // credentials, or `unresolvable`. They are the one part of this interface that is deliberately not a
  // precondition: `db` and `secret` above fail the whole instance, and a provider does not (#381).
  /** Deliver a magic link or OTP. Enqueues an email job; never sends inline. */
  sendEmail: SendAuthEmail;
  /**
   * The catalog locale this request negotiated, or `null` when nothing did.
   *
   * Threaded through to the translator plugin, which is what puts Better Auth's own refusals in the
   * reader's language (#452). An instance is built per request, so this is that request's locale.
   */
  locale?: string | null;
  /** Session lifetime in seconds. */
  sessionExpiresIn: number;
  /** How often (seconds) an active session's expiry slides forward. */
  sessionUpdateAge: number;
  /** Magic-link / OTP token lifetime in seconds. */
  verificationExpiresIn: number;
  /** OTP length (digits). */
  otpLength: number;
  /** When true, sign-in never provisions a new user (existing accounts only). Magic link and OTP. */
  disableSignUp: boolean;
  /**
   * Whether each social provider may create an account, from that provider's `allowSignUp` toggle.
   *
   * **A second question from {@link disableSignUp}, and the reason it is separate.** The dashboard needs
   * *email* sign-up — somebody creating an organization — and *no* GitHub sign-up. One global boolean
   * cannot say that, and the gap is exactly how a GitHub sign-in minted a second, empty user beside the
   * real account (pithy-sh/pithy#554). Better Auth has supported this per provider all along; the kit
   * simply never surfaced it.
   */
  providerSignUp: Readonly<Record<SocialProviderId, boolean>>;
  /**
   * How a GitHub identity is resolved, or `undefined` for the kit's own rule.
   *
   * The one seam an adopter overrides to build a richer ladder — `getUserInfo` is the only hook running
   * before both fetches and before `mapProfileToUser`, and the only one holding the OAuth token. See
   * `githubUserInfo.ts` for the default and why it is primary-only.
   */
  resolveGithubUserInfo?: GithubUserInfoResolver;
  /** Audit seam — emits `auth/*` events. A no-op when the audit capability is absent. */
  emit: AuditEmit;
  /**
   * Called when a session row is deleted — a sign-out, a revoke, an admin ending somebody's devices.
   *
   * **The seam exists because a session id is a key other capabilities hang state on**, and nothing
   * else tells them it has gone. `@pithy-sh/organization` keys its acting selection by session id and
   * states that signing out must take it with it; without this there was no moment at which it could,
   * so every sign-in/sign-out cycle left an orphan row in a table with no TTL and no sweep.
   *
   * Wired by the project that composes both — a capability does not reach into another, and the
   * direction is wrong anyway: tenancy depends on auth, not the reverse.
   *
   * **Non-fatal by contract.** By the time this runs the session is already gone; a failure here must
   * not turn a completed sign-out into an error the caller retries. Implementations swallow their own.
   */
  onSessionRevoked?: (session: { id: string; userId: string }) => Promise<void>;
  /**
   * The adopter's additional Better Auth plugins, from `auth({ plugins: [...] })`. Composed **after**
   * the kit's own, never in place of one — `assertAdditivePlugins` has already refused a list that
   * names one of them.
   */
  plugins: Plugins;
}

/**
 * The concrete return type of `makeAuth` — the Better-Auth instance with Pithy's plugin set, and the
 * adopter's on top of it.
 *
 * Parameterized in the plugin tuple so an adopter can name the instance their own composition produces:
 * `AuthInstance<[ReturnType<typeof organization>]>`. That is the type
 * `inferAdditionalFields<…>()` needs on the client, and the reason the plugin tuple is threaded through
 * `makeAuth` rather than widened to `BetterAuthPlugin[]` at the door.
 */
export type AuthInstance<Plugins extends readonly BetterAuthPlugin[] = readonly BetterAuthPlugin[]> = ReturnType<
  typeof makeAuth<Plugins>
>;

/**
 * Build the Better-Auth instance for one request.
 *
 * Passwordless only — `emailAndPassword` is never enabled. The Kysely adapter wraps our shared
 * `CamelCasePlugin` instance, so Better Auth's camelCase model names + fields map to the snake_case
 * `pithy_auth_*` columns the migration created. Dates are ISO-8601 text on SQLite; ids are WebCrypto
 * UUIDs; rate limiting is durable (D1-backed) since memory limiting is per-isolate on Workers.
 */
export function makeAuth<const Plugins extends readonly BetterAuthPlugin[]>(deps: AuthInstanceDeps<Plugins>) {
  return betterAuth({
    appName: "Pithy",
    baseURL: deps.baseURL,
    basePath: deps.basePath,
    secret: deps.secret,
    telemetry: { enabled: false },
    trustedOrigins: deps.trustedOrigins,
    database: { db: deps.db, type: "sqlite", transaction: false },
    advanced: {
      // WebCrypto UUID ids for every model — anti-enumeration, Workers-safe.
      database: { generateId: () => crypto.randomUUID() },
    },
    // Better Auth's errors bubble out of `handler` so the Hono boundary maps them to PithyError.
    //
    // **Load-bearing, and measured rather than assumed (#385).** The `before` hook below throws a
    // `PithyError`, which better-call's router does not recognize as its own `APIError` — so without
    // this it takes the default branch: `console.error("# SERVER_ERROR: ", error)`, which prints the
    // whole payload including the `action` naming `auth-github-credentials`, and answers a bodyless
    // 500. Removing it reddens two cases in `http/providerResolution.workers.test.ts` (503 becomes
    // 500, and the caller's message disappears) and puts a secret name in the log. A handler could not
    // replace it: `onAPIError.onError`'s return value is ignored, so the only way it reaches the same
    // outcome is by throwing, which is what this is.
    onAPIError: { throw: true },
    databaseHooks: {
      user: {
        create: {
          // Seeding guard: refuse to create a user whose email a provider has not verified. Every
          // passwordless sign-up creates emailVerified=true and every trusted/verified social sign-up
          // carries a verified flag, so only an untrusted+unverified social sign-up is blocked — the
          // vector where a provider could seed a rival row at an address the caller doesn't own.
          before: async (user) => {
            if (isUnverifiedSignup(user)) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_NOT_VERIFIED",
                message:
                  "This email isn't verified by the provider. Sign in with a magic link to verify it, then connect the provider.",
              });
            }
            // **Sanitized, not refused.** This is a provider's profile arriving mid-sign-in, and the
            // person signing in did not choose it — see `../profile/profile.ts`. A long name is
            // truncated, an avatar this kit will not hold becomes initials, and they get in.
            const safe = sanitizeProfile(user);
            if (Object.keys(safe).length > 0) return { data: { ...user, ...safe } };
          },
        },
        update: {
          // The profile gate. **Every** write to `name` or `image` passes through here — Better Auth's
          // own `/update-user`, an adopter's route, an admin tool — because the hook is at the adapter
          // rather than at any one door. `../profile/profile.ts` records why a validator declared
          // beside the column would not have run: `parseUserInput` reaches the additional fields only,
          // and these two are Better Auth's own.
          before: async (user) => {
            refuseUnsafeProfileFields(user);
          },
        },
      },
      account: {
        /**
         * **The provider-link trail, recorded where the account table changes.**
         *
         * An account row is what lets a provider sign in as somebody, so its creation and its removal
         * are the two account-security events — and the row is the only place both are visible. Better
         * Auth reaches it from several directions: `/callback/:id` on a first social sign-up and on a
         * link, `linkAccount` from the OAuth linking path, `/unlink-account`, and the cascade that drops
         * every account when a user is deleted. All of them go through `createWithHooks` /
         * `deleteWithHooks` on the `account` model (`better-auth/dist/db/internal-adapter.mjs`), so one
         * pair of hooks covers what four endpoint wirings would have had to enumerate and keep current.
         *
         * **This is the seam `session.delete.after` below already argues for**, applied to the other
         * table: a handler wired to one endpoint misses the others, and the row is what the fact is
         * keyed by. #627 is what that costs — `/link-social` was wired, so a link recorded the request
         * rather than the result, and an unlink recorded nothing.
         *
         * **After, not before, in both directions.** The write has happened by the time these run, so a
         * slow or failing audit seam can neither hold up nor refuse a link or an unlink — and
         * `emitProviderAccountChanged` swallows its own failure for the same reason.
         */
        create: {
          after: async (account, ctx) => {
            await emitProviderAccountChanged(deps.emit, {
              change: "link",
              account,
              ...callerOf(ctx),
            });
          },
        },
        delete: {
          /**
           * **The claim, not the emit.** `deleteWithHooks` fires `delete.after` on the row it read
           * rather than on a row it removed, so two concurrent unlinks of the same account both reach
           * `after` and the trail double-counts one removal. `claimAccountRemoval` issues the delete
           * itself and only the caller whose statement removed the row goes on to emit — see
           * `../audit/evidence.ts` for why pre-empting Better Auth's delete is safe at this position.
           */
          before: async (account) => {
            await claimAccountRemoval(deps.db, account);
          },
          after: async (account, ctx) => {
            if (!removalWasClaimed(account)) return;
            await emitProviderAccountChanged(deps.emit, {
              change: "unlink",
              account,
              ...callerOf(ctx),
            });
          },
        },
      },
      session: {
        create: {
          /**
           * Stamp when this session's holder authenticated, and bind the session to its device.
           *
           * **`authenticatedAt` is stamped here and nowhere else.** A sign-in is the only event that is
           * an authentication; `/token/rotate` carries the value forward through `createSession`'s
           * override instead, which is why a rotated session keeps the original instant. A field
           * `defaultValue` would have looked equivalent and is not: `getSessionDefaultFields` is spread
           * into the row *after* the caller's override, so it would overwrite the carried value and
           * silently restore the defect the column exists to fix (#558).
           *
           * A value already on the row is left alone — that is the rotation, passing its own.
           *
           * **Every other `createSession` is treated as an authentication, which is right for all of
           * them the kit composes.** `better-auth/plugins/admin`'s `impersonateUser` would be the
           * exception — an admin impersonating somebody would get a freshly-stamped session and could
           * attach a provider to that account — but the kit composes no admin plugin, so it is a note
           * for whoever does rather than a live path.
           *
           * Device binding only fires when the request carried device headers; a rotation passes
           * `deviceId` by override for the same reason.
           */
          before: async (session, ctx) => {
            // **`undefined` and `null` are different answers here, and collapsing them is a hole.**
            // Absent means nobody supplied one, which is a sign-in: stamp it. Present-and-null is a
            // rotation of a session written before the column existed, and it must stay null so the gate
            // keeps refusing rather than being handed a fresh instant. `??` would have treated both as
            // "stamp now", which is the fail-open `routes.ts` describes at length.
            const carried = (session as { authenticatedAt?: Date | null }).authenticatedAt;
            const authenticatedAt = carried !== undefined ? carried : new Date();
            const meta = ctx?.headers ? parseDeviceMeta(ctx.headers) : undefined;
            if (!meta) return { data: { ...session, authenticatedAt } };
            await registerDevice(deps.db, meta, {
              userId: session.userId,
              lastIp: session.ipAddress ?? null,
              now: new Date(),
            });
            return { data: { ...session, deviceId: meta.id, authenticatedAt } };
          },
        },
        delete: {
          /**
           * Tell whoever keyed state on this session that it has gone.
           *
           * A sign-out, a revoke, an admin ending somebody's devices — all of them land here, which is
           * why the seam is on the row rather than on the sign-out endpoint. A handler wired to one
           * endpoint would miss the other three, and the row is what the state was keyed by.
           *
           * **After, not before.** The session is already gone when this runs, so a slow or failing
           * listener cannot hold up or refuse a sign-out — and it swallows its own failure for the same
           * reason the audit emit does: the thing it reports has already happened.
           */
          after: async (session, ctx) => {
            // **The evidence `/sign-out` has none of.** That endpoint answers 200 whether or not it
            // found a session to delete, so the path alone cannot say whether anybody was signed out.
            // A session row disappearing can, and this is where that is visible (#627).
            markSessionEnded((ctx as { context?: unknown } | null | undefined)?.context, session.userId);
            if (!deps.onSessionRevoked) return;
            try {
              await deps.onSessionRevoked({ id: String(session.id), userId: String(session.userId) });
            } catch {
              // Swallowed by contract. The sign-out succeeded; a listener's failure is not the caller's.
            }
          },
        },
      },
    },
    hooks: {
      /**
       * Refuse a provider this deployment enables and could not resolve, before Better Auth answers it
       * with the 404 it gives a provider nobody configured (#381).
       *
       * **This is what makes degrading not the same as degrading quietly.** The instance was built
       * without the provider, so `socialProviders` does not hold it, so `sign-in/social` would throw
       * `PROVIDER_NOT_FOUND` — a 404 that tells somebody who signs in with GitHub every day that
       * GitHub was never set up. It is the same answer for a fault and for a choice, and the two are
       * not the same fact. This hook answers 503 with its own code instead, and records the attempt.
       *
       * **A `before` hook rather than a Hono route, and that is forced rather than preferred.** The
       * provider is in the request *body*, and the body is Better Auth's to read: a Hono handler ahead
       * of the catch-all would have to consume the stream that the catch-all then hands to
       * `instance.handler(c.req.raw)`. Here the body is already parsed against the endpoint's own
       * schema, and this reads one field out of it.
       */
      before: createAuthMiddleware(async (ctx) => {
        const provider = unavailableProviderFor(ctx.path ?? "", ctx.body, deps);
        if (!provider) return;
        // Recorded before the throw, so the trail holds the attempt whether or not anything logs the
        // refusal. `emitProviderUnavailable` swallows its own failure by contract.
        await emitProviderUnavailable(deps.emit, { provider, headers: ctx.headers });
        throw providerUnavailable(provider);
      }),
      /**
       * Emit audit events for an auth request: sign-in (+device) from the new session, plus the
       * send/sign-out/token event by path. Endpoint-scoped, so a rotation never emits.
       *
       * **`returned` is passed because this hook runs on refusals too.** Better Auth catches an
       * endpoint's `APIError` into a result and dispatches the `after` hooks over it
       * (`better-auth/dist/api/dispatch.mjs`), so a 401 `/token` reaches here looking exactly like one
       * that minted a token — and wrote `auth/token_refresh outcome=success` for a request that was
       * refused. `ctx.context.returned` is the only thing that tells them apart, and the judgment is
       * `emitAfterRequest`'s so it is made once for every path rather than per wiring.
       *
       * **The two markers are passed because a refusal can answer 200.** `/sign-out` deletes nothing and
       * says so cheerfully; `/email-otp/send-verification-otp` declines to send and answers
       * `{"success":true}` on purpose, so a caller cannot tell a registered address from a stranger's.
       * Neither decline is visible from anything this hook holds, so each audited path names what must
       * have *happened* and `../audit/evidence.ts` carries it here from the place that saw it — the
       * session row going away, and the email seam's own answer about the message, which is the send
       * paths' evidence rather than the fact that a callback was entered. Reading them is all this does:
       * the response has already been decided and is not touched.
       */
      after: createAuthMiddleware(async (ctx) => {
        const newSession = ctx.context.newSession;
        await emitAfterRequest(deps.emit, {
          path: ctx.path ?? "",
          headers: ctx.headers,
          newSession: newSession
            ? {
                userId: newSession.user.id,
                sessionId: newSession.session.id,
                deviceId: (newSession.session as { deviceId?: string | null }).deviceId ?? null,
              }
            : null,
          currentUserId: ctx.context.session?.user?.id ?? null,
          returned: ctx.context.returned,
          endedSession: sessionEndedDuring(ctx.context),
          messageDelivery: messageDeliveryDuring(ctx.context),
        });
      }),
    },
    rateLimit: {
      // Memory limiting is per-isolate (useless on Workers); back it with the durable D1 table.
      enabled: true,
      storage: "database",
      modelName: "pithyAuthRateLimit",
    },
    user: {
      modelName: "pithyAuthUsers",
      // One declaration, shared with the schema baseline in `../migrations/pluginTables.ts`. See
      // `../data/kitFields.ts` for why a column missing here is invisible to Better Auth, and why the
      // two used to be written out twice.
      additionalFields: KIT_USER_FIELDS,
    },
    session: {
      modelName: "pithyAuthSessions",
      expiresIn: deps.sessionExpiresIn,
      updateAge: deps.sessionUpdateAge,
      /**
       * Better Auth's own re-authentication window, stated rather than inherited.
       *
       * Its default is 24 hours, which nobody here chose, and it is the number `freshSessionMiddleware`
       * holds `/unlink-account` to. Bringing it to the kit's own window means the two checks on that
       * endpoint agree instead of one silently permitting a day.
       *
       * **It is defense in depth, not the control.** `freshSessionMiddleware` measures
       * `session.createdAt`, which `/token/rotate` restamps — so narrowing it narrows a window that is
       * still resettable. The control is `http/providerFreshness.ts`, which reads the authentication
       * instant a rotation carries forward, and it is strictly the stricter of the two: `createdAt` is
       * never older than `authenticatedAt`, so anything our gate admits this one admits too.
       */
      freshAge: PROVIDER_CHANGE_FRESH_AGE_SECONDS,
      // Server-set session fields clients never supply: the bound device, and the refresh-token family
      // (carried across rotations via createSession override, like deviceId — see `token/rotation.ts`).
      additionalFields: KIT_SESSION_FIELDS,
    },
    account: {
      modelName: "pithyAuthAccounts",
      accountLinking: {
        enabled: true,
        // Link a social sign-in to an existing magic-link user when the verified emails match.
        trustedProviders: ["google", "apple"],
        /**
         * **A signed-in user may attach a provider whose email differs from their account's.**
         *
         * Both sides are proven at that moment: they authenticated as the account, and they just
         * authenticated with the provider. Without this, a GitHub account whose primary is not the
         * sign-up address can never be attached at all.
         *
         * **This flag alone would be the wrong fix and is not the whole of it.** It permits *any*
         * differing address, including one the provider never verified — and Better Auth performs no
         * independent check on what a resolver hands back. The verified boundary is held by
         * `githubUserInfo.ts`, which reports the provider's real per-address flag and never a literal;
         * and `http/linkFreshness.ts` is what stops a stolen credential using this to attach an
         * identity permanently. Neither is optional, and #558 records why the obvious version of that
         * second guard — session age — was defeated by a single `/token/rotate`.
         */
        allowDifferentEmails: true,
        /**
         * **A provider is never the last way in, which is also what makes an orphaned link recoverable.**
         *
         * Better Auth refuses to unlink somebody's only account, on the reasonable fear of locking them
         * out. That fear does not apply here: magic link is unconditional in this kit, so every user can
         * always reach their own address, and the "last account" it is protecting is a provider link
         * rather than a credential.
         *
         * It also settles #554's orphan without a merge rule. A GitHub sign-in that minted an empty user
         * holds the provider identity, so linking it to the real account collides. With this, the owner
         * of that empty account — who controls its address, or magic link could not have created it —
         * signs in, unlinks GitHub, and links it where it belongs. At no point does one account take an
         * identity from another; one gives it up, authenticated as itself. A claim-from-an-empty-account
         * rule is where takeover bugs live, and this needs none.
         */
        allowUnlinkingAll: true,
      },
    },
    verification: { modelName: "pithyAuthVerifications" },
    ...((): { socialProviders?: Record<string, unknown> } => {
      const providers = socialProviders(deps);
      return providers ? { socialProviders: providers } : {};
    })(),
    // The kit's four first, the adopter's after. Order is the contract: Better Auth merges plugin
    // endpoints by id and a later registration wins, so composing the adopter's list first would let
    // it quietly redefine the sign-in this product promises. `assertAdditivePlugins` has already
    // refused a list that names one of the four; this order is what makes that refusal the only way in.
    plugins: [...kitPlugins(deps), ...deps.plugins],
  });
}
