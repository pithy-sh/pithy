// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emitAfterRequest, emitProviderUnavailable } from "../audit/emit";
import { KIT_SESSION_FIELDS, KIT_USER_FIELDS } from "../data/kitFields";
import type { AuthDatabase } from "../data/tables";
import { parseDeviceMeta, registerDevice } from "../device/registry";
import { kitPlugins } from "./plugins";
import { providerUnavailable, type ResolvedProviders, unavailableProviderFor } from "./providers";

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
export function socialProviders(deps: AuthInstanceDeps): Record<string, unknown> | undefined {
  const providers: Record<string, unknown> = {};
  if (deps.google.state === "ready") {
    providers.google = {
      clientId: deps.google.credentials.clientId,
      clientSecret: deps.google.credentials.clientSecret,
      accessType: "offline",
      prompt: "select_account consent",
    };
  }
  if (deps.apple.state === "ready") {
    const apple = deps.apple.credentials;
    providers.apple = {
      clientId: apple.clientId,
      clientSecret: apple.clientSecret,
      ...(apple.appBundleIdentifier ? { appBundleIdentifier: apple.appBundleIdentifier } : {}),
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
 * What the instance hands to Pithy's email seam to deliver. The route never sends inline — the hook
 * enqueues an `@pithy-sh/email` job (`magicLink`/`otp` template) which a Workflow delivers.
 */
export type AuthEmailMessage =
  | { to: string; template: "magicLink"; token: string; url: string }
  | { to: string; template: "otp"; code: string };

/** The email-delivery seam: enqueue (never send inline). Injected so the instance stays I/O-agnostic. */
export type SendAuthEmail = (message: AuthEmailMessage) => Promise<void>;

/**
 * Everything the Better-Auth instance needs, resolved per invocation from config + request env.
 *
 * Generic in the adopter's plugin tuple so the composed instance's type — and therefore its `$Infer`
 * surface — reflects what was actually composed rather than only the kit's four.
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
  /** Session lifetime in seconds. */
  sessionExpiresIn: number;
  /** How often (seconds) an active session's expiry slides forward. */
  sessionUpdateAge: number;
  /** Magic-link / OTP token lifetime in seconds. */
  verificationExpiresIn: number;
  /** OTP length (digits). */
  otpLength: number;
  /** When true, sign-in never provisions a new user (existing accounts only). */
  disableSignUp: boolean;
  /** Audit seam — emits `auth/*` events. A no-op when the audit capability is absent. */
  emit: AuditEmit;
  /**
   * The adopter's additional Better Auth plugins, from `auth({ plugins: [...] })`. Composed **after**
   * the kit's four, never in place of one — `assertAdditivePlugins` has already refused a list that
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
          },
        },
      },
      session: {
        create: {
          // Bind the session to its device (registering the device first, so the linkage is valid).
          // Only fires when a request carried device headers — an internal rotation passes deviceId
          // via override instead, so this hook leaves it untouched.
          before: async (session, ctx) => {
            const meta = ctx?.headers ? parseDeviceMeta(ctx.headers) : undefined;
            if (!meta) return;
            await registerDevice(deps.db, meta, {
              userId: session.userId,
              lastIp: session.ipAddress ?? null,
              now: new Date(),
            });
            return { data: { ...session, deviceId: meta.id } };
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
      // Emit audit events for every completed auth request: sign-in (+device) from the new session,
      // plus the send/sign-out/token/OAuth events by path. Endpoint-scoped, so a rotation never emits.
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
