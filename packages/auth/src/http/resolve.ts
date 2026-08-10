// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { EmailEnqueueEnv } from "@pithy-sh/email/src/capability";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import type { Context } from "hono";
import type { AuthWiring } from "../capability";
import { authDatabase } from "../data/tables";
import { makeSendAuthEmail } from "../email/send";
import { type AuthInstance, makeAuth } from "../instance/auth";
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
  // Secret resolutions hit the same per-invocation cache; run them concurrently. A disabled provider
  // skips its own `.get()` here (resolves to `undefined`) — but every declared auth secret, provider
  // credentials included, is still materialized once by the shared store's batch resolution (the
  // session-secret read below triggers it). So a provider's secret must be provisioned per environment
  // whether or not it is enabled — the pre-existing contract for `google`/`apple` too.
  const [secret, google, apple, facebook, github] = await Promise.all([
    resolveSessionSecret(env),
    cfg.google.enabled ? resolveGoogleCredentials(env) : Promise.resolve(undefined),
    cfg.apple.enabled ? resolveAppleCredentials(env) : Promise.resolve(undefined),
    cfg.facebook.enabled ? resolveFacebookCredentials(env) : Promise.resolve(undefined),
    cfg.github.enabled ? resolveGithubCredentials(env) : Promise.resolve(undefined),
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
    sendEmail: makeSendAuthEmail((input) => enqueueEmail(env, input), expiresMinutes),
    sessionExpiresIn: cfg.sessionExpiresIn,
    sessionUpdateAge: cfg.sessionUpdateAge,
    verificationExpiresIn: cfg.verificationExpiresIn,
    otpLength: cfg.otpLength,
    disableSignUp: cfg.disableSignUp,
    // Read the emit seam lazily so a later-composed audit capability is honored regardless of the
    // capability order (the instance may be built before audit's middleware runs).
    emit: (event) => c.var.emit(event),
  });
}
