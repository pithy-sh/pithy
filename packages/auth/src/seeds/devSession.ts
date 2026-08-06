// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { fromZodError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { DEV_LOGIN_FILE, DEV_LOGIN_PATH, DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import { EXAMPLE_IDENTITIES, type ExampleIdentity } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedPreparation, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { z } from "zod";
import { Session } from "../data/betterAuth";
import { AUTH_SESSION_SECRET } from "../instance/secrets";

/**
 * The dev-login seed set: a real, signed-in session for one seeded user, so local development does not
 * begin with a magic-link round trip.
 *
 * Sign-in is passwordless by design, which is right in production and a tax in development — and more
 * than a tax for anything automated, which cannot read a mailbox at all. The interesting part is *where*
 * the work happens: the session is minted during seed, so the database holds a genuine row and the browser
 * is handed a genuine cookie. Nothing about the request path is relaxed to make it work.
 *
 * Four guard rails, because what this writes is a live credential:
 *
 * - `environments: ["dev"]` — it can never be composed into staging or production.
 * - No `~/.config/<project>/dev.json`, no session. The default stays "there is no way in but a magic link";
 *   opting in is a per-machine file outside the repo, so two developers on one checkout can differ.
 * - The login file is transient, written under the gitignored `logs/` ({@link DEV_LOGIN_PATH}). A seeded
 *   cookie must never be committable.
 * - `example: true` — it signs in as one of the canonical example identities, which only exist when the
 *   project turns on `seed.includeExamples`. A session for a user nobody seeded would be a dangling row.
 */

/** Where this set sorts: after `auth`'s example set (100), whose users it mints a session for. */
export const AUTH_DEV_SESSION_SEED_ORDER = 110;

/**
 * The cookie Better Auth reads the session from. Better Auth builds it as `<cookiePrefix>.session_token`
 * (prefix `better-auth` unless `advanced.cookiePrefix` overrides it, which Pithy does not), plus a
 * `__Secure-` prefix when the base URL is HTTPS — which a `dev` base URL is not. Locked to the running
 * version by a test that reads the name off a live instance, so a Better Auth upgrade that renamed it
 * fails here rather than in a browser.
 */
export const DEV_SESSION_COOKIE_NAME = "better-auth.session_token";

/** How long a seeded session lives. Long, because reseeding to restore a dev login is the friction this removes. */
const DEV_SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** Bytes of the secret digest kept as the token's fingerprint — enough to separate secrets, short enough to read. */
const FINGERPRINT_BYTES = 4;

/** The developer's machine-local preferences for this project, read from `~/.config/<project>/dev.json`. */
export const DevPreferences = z
  .object({
    user: z
      .string()
      .describe(
        "The email of the seeded user to sign in as. Must be one of the seeded example identities, or the seed fails rather than signing in as nobody.",
      ),
  })
  .describe(
    "A developer's machine-local dev preferences (`$XDG_CONFIG_HOME/<project>/dev.json`, else `~/.config/...`) — outside the repo, so opting in needs no commit.",
  );
export type DevPreferences = z.output<typeof DevPreferences>;

/** What {@link mintDevSession} produces: the row to write, and the artifact the browser is handed. */
export interface MintedDevSession {
  /** The `pithy_auth_sessions` row, in app shape — re-encoded and validated by the seed writer. */
  session: Session;
  /** The dev-login artifact, written to `logs/dev-login.json` once the row lands. */
  login: DevLogin;
}

/**
 * Sign a value the way better-call does, so Better Auth accepts the cookie as one it signed itself:
 * HMAC-SHA-256 over the value with the auth secret, base64, appended after a dot, then URI-encoded.
 *
 * Mirrored rather than imported: `signCookieValue` is internal to `better-call/dist/crypto`, not part of
 * anything Better Auth re-exports, so importing it would bind us to a private path. Verified against
 * better-call 1.3.6 — the version Better Auth 1.6.19 resolves — and pinned by a round-trip test that makes
 * a real instance accept the result, which is the only check that actually matters.
 */
async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return encodeURIComponent(`${value}.${base64}`);
}

/**
 * A short, stable fingerprint of the auth secret.
 *
 * Putting it in the session token makes the token deterministic across reseeds — the same cookie keeps
 * working in every worktree once each is seeded, which is the whole point — while rotating the secret
 * changes the token *and* invalidates every cookie signed with the old one, for free. A truncated digest,
 * never the secret: the token is written to a file and read back by tooling.
 */
async function secretFingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest).slice(0, FINGERPRINT_BYTES))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Inputs to {@link mintDevSession}. `now` is a seam so the determinism tests do not depend on the clock. */
export interface MintDevSessionInput {
  /** The seeded identity to sign in as. */
  identity: ExampleIdentity;
  /** The Better Auth signing secret for this environment — never logged, never stored, never in an error. */
  secret: string;
  /** The moment the session is minted. Defaults to now. */
  now?: Date;
}

/**
 * Mint one deterministic dev session: the `pithy_auth_sessions` row and the signed cookie for it.
 *
 * The row id carries the fingerprint too, not just the token. Seed writes are `INSERT OR IGNORE`, so an
 * id that ignored a rotation would keep the stale token alive under a row the next run refuses to replace.
 */
export async function mintDevSession(input: MintDevSessionInput): Promise<MintedDevSession> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + DEV_SESSION_LIFETIME_MS);
  const fingerprint = await secretFingerprint(input.secret);
  const token = `dev-session-${input.identity.id}-${fingerprint}`;

  const session: Session = {
    id: token,
    token,
    userId: input.identity.id,
    expiresAt,
    createdAt: now,
    updatedAt: now,
    ipAddress: "127.0.0.1",
    userAgent: "pithy seed (dev login)",
    deviceId: null,
    familyId: null,
  };

  return {
    session,
    login: {
      email: input.identity.email,
      userId: input.identity.id,
      cookieName: DEV_SESSION_COOKIE_NAME,
      cookieValue: await signCookieValue(token, input.secret),
      expiresAt,
    },
  };
}

/** The seeded emails a `dev.json` may name — the actionable half of every failure here. */
function seededEmails(): string {
  return EXAMPLE_IDENTITIES.map((identity) => identity.email).join(", ");
}

/** Resolve the preference file into the identity to sign in as, or fail saying which emails exist. */
function requireIdentity(preferences: unknown): ExampleIdentity {
  const parsed = DevPreferences.safeParse(preferences);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "The dev.json preference file does not name a user.",
      action: `Set { "user": "<email>" } in it. Seeded users: ${seededEmails()}.`,
    });
  }
  const identity = EXAMPLE_IDENTITIES.find((candidate) => candidate.email === parsed.data.user);
  if (!identity) {
    throw new ValidationError({
      message: `dev.json asks to sign in as ${parsed.data.user}, which no seed creates.`,
      action: `Name one of the seeded users instead: ${seededEmails()}.`,
    });
  }
  return identity;
}

/**
 * The dev-login seed set. Composed by the auth capability; runs only in `dev`, only with examples on, and
 * only when the developer has opted in with a `dev.json`.
 */
export const authDevSessionSeed: SeedSet = defineSeed({
  name: "dev-session",
  order: AUTH_DEV_SESSION_SEED_ORDER,
  environments: ["dev"],
  example: true,
  prepare: async (context): Promise<SeedPreparation> => {
    // No dev.json, no session. This is the default, and it is the one that keeps "there is no way in but
    // a magic link" true for everyone who never asked for anything else.
    if (context.preferences === undefined || context.preferences === null) return {};

    const identity = requireIdentity(context.preferences);
    const secret = await context.secret(AUTH_SESSION_SECRET);
    if (!secret) {
      throw new ValidationError({
        message: "Cannot mint a dev session without this environment's auth secret.",
        action: `Add ${AUTH_SESSION_SECRET} to .dev.vars, then seed again.`,
      });
    }

    const minted = await mintDevSession({ identity, secret });
    return {
      d1: [d1SeedGroup("app", "pithyAuthSessions", Session, [minted.session])],
      artifacts: [{ file: DEV_LOGIN_FILE, contents: `${JSON.stringify(DevLogin.encode(minted.login), null, 2)}\n` }],
    };
  },
});
