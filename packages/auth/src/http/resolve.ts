// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { EmailEnqueueEnv } from "@pithy-sh/email/src/capability";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import type { Context } from "hono";
import type { AuthWiring } from "../capability";
import { authDatabase } from "../data/tables";
import { makeSendAuthEmail, type ResolveRecipientLocale } from "../email/send";
import { type AuthInstance, makeAuth } from "../instance/auth";
import { resolveProvider } from "../instance/providers";
import {
  resolveAppleCredentials,
  resolveFacebookCredentials,
  resolveGithubCredentials,
  resolveGoogleCredentials,
  resolveSessionSecret,
} from "../instance/secrets";
import { baseURLResolver } from "./baseUrl";

/**
 * Build the Better-Auth instance for one request, memoized on the request context so the
 * session-resolving middleware and the route handler share a single instance (one secret resolution,
 * one construction). The instance closes over request-scoped state: the audit `emit` seam and the D1
 * binding from `c.env`.
 */
const cache = new WeakMap<object, Promise<AuthInstance>>();

type AuthEnv = SecretsStoreEnv & EmailEnqueueEnv;

/** Read the configured D1 binding by name from the worker env, or fail loudly (not a silent undefined). */
export function resolveDb(env: Record<string, unknown>, bindingName: string): D1Database {
  const binding = env[bindingName];
  if (!binding) {
    throw new InternalError({
      message: "The auth database binding is missing.",
      detail: `D1 binding "${bindingName}" is not present on the worker env`,
    });
  }
  return binding as D1Database;
}

/**
 * The language to write a sign-in email in, for one address.
 *
 * **The stored preference first, the request's negotiation second** (pithy-sh/pithy#441). Somebody who
 * picked a language in a settings pane has said something durable about themselves; the device they are
 * signing in from tonight has only sent an `Accept-Language`. But most of what this is asked about is a
 * *first* sign-in, where no row exists yet — and that is precisely the message a project cannot afford
 * to send in the wrong language, because passwordless has no password to fall back to. So the header's
 * answer, which `@pithy-sh/i18n` has already matched against this project's supported set and put on
 * `c.var.locale`, is what covers that case.
 *
 * One indexed lookup on a unique column, per sign-in email, and only for the two templates that send
 * one. `null` when neither answers, which renders the kit's English — not the same statement as `en`.
 *
 * `c.var.locale` is null unless the i18n capability is composed, so a project that never opted in gets
 * a resolver that reads a column nobody fills and returns null: the behavior it had before any of this.
 */
function recipientLocale(c: Context<PithyHonoEnv>, db: ReturnType<typeof authDatabase>): ResolveRecipientLocale {
  return async (email) => {
    const row = await db.selectFrom("pithyAuthUsers").select("locale").where("email", "=", email).executeTakeFirst();
    return row?.locale ?? c.var.locale?.catalogLocale ?? null;
  };
}

export function getAuthInstance(c: Context<PithyHonoEnv>, wiring: AuthWiring): Promise<AuthInstance> {
  const existing = cache.get(c);
  if (existing) return existing;
  const built = buildAuthInstance(c, wiring);
  cache.set(c, built);
  return built;
}

async function buildAuthInstance(c: Context<PithyHonoEnv>, wiring: AuthWiring): Promise<AuthInstance> {
  const cfg = wiring.config;
  const enqueueEmail = wiring.enqueueEmail;
  if (!enqueueEmail) {
    throw new InternalError({
      message: "Authentication is misconfigured.",
      detail: "auth.compose did not resolve the email enqueue seam; ensure email() is composed.",
    });
  }
  const env = c.env as unknown as AuthEnv;
  // Secret resolutions hit the same per-invocation cache; run them concurrently. Five reads, and they
  // are not alike — which is the whole of #381.
  //
  // `resolveSessionSecret` is what an auth instance *is*: nothing signs a session without it, so its
  // failure stays a precondition and still fails this call. `resolveDb` below is the same. A provider
  // credential is one sign-in method among several, and it used to sit in this list as an equal — so a
  // single unreadable `auth-github-credentials` rejected the whole `Promise.all` and every magic-link
  // and OTP caller in the deployment got the secrets reader's own refusal instead of a sign-in:
  // measured, `404 secrets/not_found`, message `Secret 'auth-github-credentials' is declared but not
  // provisioned.` So the old behavior named the secret loudly and named it to *the browser*, on a
  // route that has nothing to do with GitHub. Both halves of that are fixed here.
  //
  // `resolveProvider` catches per provider and hands back a state rather than a rejection, so this
  // `Promise.all` settles whenever the session secret does. What the instance then lacks is one
  // provider, and `makeAuth`'s `before` hook answers a caller who asks for it — see `instance/providers.ts`.
  //
  // A held failure belongs to its own secret (#170), so an unreadable provider credential does not
  // disturb the session secret's own read, and a *disabled* provider never calls `.get()` at all.
  const [secret, google, apple, facebook, github] = await Promise.all([
    resolveSessionSecret(env),
    resolveProvider(cfg.google.enabled, () => resolveGoogleCredentials(env)),
    resolveProvider(cfg.apple.enabled, () => resolveAppleCredentials(env)),
    resolveProvider(cfg.facebook.enabled, () => resolveFacebookCredentials(env)),
    resolveProvider(cfg.github.enabled, () => resolveGithubCredentials(env)),
  ]);
  const expiresMinutes = Math.max(1, Math.round(cfg.verificationExpiresIn / 60));
  return makeAuth({
    db: authDatabase(resolveDb(c.env, cfg.database)),
    secret,
    // Never `cfg.baseURL` directly. The instance derives the session cookie's name, the OAuth callback
    // URLs, and the magic-link URL from whatever base URL it is handed, so in a `dev` composition every
    // one of those has to name the address this run is actually serving on — not the production origin
    // the config records. The gate lives in `baseURLResolver` and nowhere else; outside `dev` this is
    // `cfg.baseURL`, unchanged. Resolved here because the instance is itself built per request.
    baseURL: baseURLResolver(cfg.baseURL)(c.req.raw),
    basePath: cfg.basePath,
    trustedOrigins: cfg.trustedOrigins,
    google,
    apple,
    facebook,
    github,
    sendEmail: makeSendAuthEmail(
      (input) => enqueueEmail(env, input),
      expiresMinutes,
      recipientLocale(c, authDatabase(resolveDb(c.env, cfg.database))),
    ),
    sessionExpiresIn: cfg.sessionExpiresIn,
    sessionUpdateAge: cfg.sessionUpdateAge,
    verificationExpiresIn: cfg.verificationExpiresIn,
    otpLength: cfg.otpLength,
    disableSignUp: cfg.disableSignUp,
    // Read the emit seam lazily so a later-composed audit capability is honored regardless of the
    // capability order (the instance may be built before audit's middleware runs).
    emit: (event) => c.var.emit(event),
    // The adopter's additional Better Auth plugins, exactly as `auth({ plugins: [...] })` declared them
    // and already checked for additivity at `auth()` call time. The same list the derived migrations
    // were built from — the routes a plugin serves and the tables it needs come from one declaration.
    plugins: cfg.plugins,
  });
}
