// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { authDatabase } from "../data/tables";
import { makeAuth } from "../instance/auth";
import { NO_SOCIAL_PROVIDERS } from "../instance/providers";

/**
 * Sign a user in for a test in the Workers pool, with a real session, and get back the headers to send.
 *
 * For an app's own `*.workers.test.ts`: a route behind `requireAuth()`, reached through a backend that composes
 * `auth()`, sees exactly what a deployed Worker would — a session row Better Auth wrote, resolved by the session
 * middleware. Nothing about the request path is stubbed.
 */

/** What {@link signInTestUser} takes. */
export interface SignInTestUserOptions {
  /** The address to sign in as. A user your seed wrote is signed in as themselves; any other address becomes a new user. */
  readonly email: string;
  /** The session secret your test seeded as `auth-session-secret`. The Worker accepts a session signed with no other. */
  readonly secret: string;
  /**
   * The `baseURL` your test's `auth()` is composed with. Defaults to `http://localhost`. It names the cookie: an
   * `https` origin sets `__Secure-better-auth.session_token`, the only name a Worker on an `https` origin reads.
   */
  readonly baseURL?: string;
}

/** A signed-in test user. */
export interface SignedInTestUser {
  /** The user's id, as `c.var.auth.userId` reads it. */
  readonly userId: string;
  /** The session's id, as `c.var.auth.sessionId` reads it. */
  readonly sessionId: string;
  /** The session token. It is the bearer credential, as a phone sends it. */
  readonly token: string;
  /** The headers to send: `Authorization: Bearer <token>`. */
  readonly headers: { readonly authorization: string };
  /**
   * The same session as a browser holds it, as a `cookie` header value, named for the `baseURL` you passed. A
   * mutating route also wants a same-origin `Origin` beside it.
   */
  readonly cookie: string;
}

/**
 * Sign `email` in by one-time code against `db`, which must hold auth's migrated tables, and return the session.
 *
 * The code is caught in memory and never mailed. The instance is built with sign-up on and no social providers,
 * so it signs in whatever your own `auth()` config allows or refuses; the session it writes is the one your
 * Worker resolves.
 */
export async function signInTestUser(db: D1Database, options: SignInTestUserOptions): Promise<SignedInTestUser> {
  const database = authDatabase(db);
  const codes: string[] = [];
  const origin = options.baseURL ?? "http://localhost";
  const instance = makeAuth({
    db: database,
    secret: options.secret,
    baseURL: origin,
    basePath: "/auth",
    trustedOrigins: [origin],
    ...NO_SOCIAL_PROVIDERS,
    sendEmail: async (message) => {
      if (message.template === "otp") codes.push(message.code);
      return { delivery: "queued" };
    },
    sessionExpiresIn: 604800,
    sessionUpdateAge: 86400,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    providerSignUp: { google: false, apple: false, facebook: false, github: false, microsoft: false },
    emit: async () => {},
    plugins: [],
  });
  await instance.api.sendVerificationOTP({ body: { email: options.email, type: "sign-in" }, headers: new Headers() });
  const otp = codes.at(-1);
  if (otp === undefined) throw new Error(`No sign-in code was issued for ${options.email}.`);
  const { headers, response } = await instance.api.signInEmailOTP({
    body: { email: options.email, otp },
    headers: new Headers(),
    returnHeaders: true,
  });
  // Read, not resolved through `getSession`: resolving touches state the test's first request should find untouched.
  const session = await database
    .selectFrom("pithyAuthSessions")
    .select("id")
    .where("token", "=", response.token)
    .executeTakeFirst();
  if (session === undefined) throw new Error(`The session minted for ${options.email} was not written.`);
  return {
    userId: response.user.id,
    sessionId: session.id,
    token: response.token,
    headers: { authorization: `Bearer ${response.token}` },
    cookie: headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; "),
  };
}
