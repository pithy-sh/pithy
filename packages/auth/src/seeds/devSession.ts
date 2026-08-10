// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { fromZodError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { MAX_SEED_ORDER } from "@pithy-sh/core/src/seed/compose";
import { DEV_LOGIN_FILE, DEV_LOGIN_PATH, DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import {
  d1SeedGroup,
  defineSeed,
  type SeedPreparation,
  type SeedPrepareContext,
  type SeedSet,
} from "@pithy-sh/core/src/seed/seed";
import { z } from "zod";
import { Session } from "../data/betterAuth";
import { DEV_PROTOCOL, sessionCookieName } from "../http/baseUrl";
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
 * - No `~/.config/pithy/<project>/dev.json`, no session. The default stays "there is no way in but a magic link";
 *   opting in is a per-machine file outside the repo, so two developers on one checkout can differ.
 * - The login file is transient, written under the gitignored `logs/` ({@link DEV_LOGIN_PATH}). A seeded
 *   cookie must never be committable.
 * - The named user must be one this run actually creates. A session for a user nobody seeded is a dangling
 *   row, so `dev.json` is checked against `context.seeded` — the run's own inventory — and a miss fails
 *   saying who *was* seeded.
 *
 * Not an example set. It seeds no users of its own; it signs in as whoever the run creates — auth's example
 * cast when the project enables `includeExamples`, the app's own users otherwise, both when both. An adopter
 * should not have to turn on a fictional cast to get a dev login, and the cast is no more seeded than before:
 * it still arrives only through `authExampleSeed`, which is still `example: true`.
 */

/**
 * Where this set sorts: last, at the ceiling. It depends on every set that can create a user — auth's own
 * example set, and an adopter's app set, which sorts high by convention — so it sorts after all of them.
 * Ties break on the namespaced key, but nothing rests on that: what this set needs to *know* comes from the
 * composed plan, not from what has already been written, and the session row carries no foreign key.
 */
export const AUTH_DEV_SESSION_SEED_ORDER = MAX_SEED_ORDER;

/** The composed registry coordinates of the users table this set reads and signs in as. */
const USERS_DATABASE = "app";
const USERS_TABLE = "pithyAuthUsers";

/**
 * The cookie Better Auth reads the session from, in the one environment this set runs in.
 *
 * It used to be a literal beside a comment asserting that a `dev` base URL is not HTTPS. Nothing made
 * that true: `baseURL` was one string for every environment, so an adopter whose production origin was
 * HTTPS — every adopter — seeded this name while the running instance looked for `__Secure-` (#244).
 * The session was there, the cookie was there, and `get-session` returned `null` with nothing logged.
 *
 * Now it is computed from the same two facts the composition computes its own name from: a `dev`
 * composition serves over {@link DEV_PROTOCOL}, and {@link sessionCookieName} is the prefix rule. The
 * host and port never enter it, which is what lets a seed name a cookie for a port not yet assigned.
 * Still locked to the running Better Auth version by a test that reads the name off a live instance.
 */
export const DEV_SESSION_COOKIE_NAME = sessionCookieName(DEV_PROTOCOL);

/**
 * The prefix every seeded dev session's id and token carry.
 *
 * It is what makes a dev session **findable without being told**, which is what the dev-login route
 * needs: the route reads the session out of D1 and has no artifact to consult (a Worker has no
 * filesystem). And it is what makes one identifiable at all — a `pithy_auth_sessions` row minted by a
 * seed is otherwise indistinguishable from one a real sign-in created.
 */
export const DEV_SESSION_TOKEN_PREFIX = "dev-session-";

/** How long a seeded session lives. Long, because reseeding to restore a dev login is the friction this removes. */
const DEV_SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** Bytes of the secret digest kept as the token's fingerprint — enough to separate secrets, short enough to read. */
const FINGERPRINT_BYTES = 4;

/** The developer's machine-local preferences for this project, read from `~/.config/pithy/<project>/dev.json`. */
export const DevPreferences = z
  .object({
    user: z
      .string()
      .describe(
        "The email of the seeded user to sign in as. Must be a user this seed run creates, or the seed fails rather than signing in as nobody.",
      ),
  })
  .describe(
    "A developer's machine-local dev preferences, from the Pithy config directory (`~/.config/pithy/<project>/dev.json`, or `%APPDATA%\\pithy\\<project>\\dev.json` on Windows) — outside the repo, so opting in needs no commit.",
  );
export type DevPreferences = z.output<typeof DevPreferences>;

/**
 * A user this run seeds, read back out of the composed plan.
 *
 * Narrow on purpose: the rows come from a set this capability does not own — an adopter's, most of the time —
 * so they cross a trust boundary and are validated, but only for the two fields a session needs. A row with
 * more in it is fine; a row without these is not a user this set can sign in as.
 */
export const SeededUser = z
  .object({
    id: z.string().min(1).describe("The user id the session's `userId` points at."),
    email: z.string().min(1).describe("The email `dev.json` names, and the login artifact records."),
  })
  .describe("A seeded `pithy_auth_users` row, narrowed to what minting a dev session for it requires.");
export type SeededUser = z.output<typeof SeededUser>;

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
export async function signCookieValue(value: string, secret: string): Promise<string> {
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
export async function secretFingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest).slice(0, FINGERPRINT_BYTES))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Inputs to {@link mintDevSession}. `now` is a seam so the determinism tests do not depend on the clock. */
export interface MintDevSessionInput {
  /** The seeded user to sign in as. */
  user: SeededUser;
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
  const token = `${DEV_SESSION_TOKEN_PREFIX}${input.user.id}-${fingerprint}`;

  const session: Session = {
    id: token,
    token,
    userId: input.user.id,
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
      email: input.user.email,
      userId: input.user.id,
      cookieName: DEV_SESSION_COOKIE_NAME,
      cookieValue: await signCookieValue(token, input.secret),
      expiresAt,
    },
  };
}

/**
 * The users this run creates, whichever set contributes them.
 *
 * A row that does not parse is skipped rather than fatal: it belongs to some other set, which owns its own
 * validation, and failing the dev login over someone else's fixture would be the wrong place to find out.
 */
function seededUsers(seeded: SeedPrepareContext["seeded"]): SeededUser[] {
  return seeded(USERS_DATABASE, USERS_TABLE).flatMap((row) => {
    const parsed = SeededUser.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/** What to do about it — the actionable half of every failure here, and never a guess. */
function nameOneOf(users: readonly SeededUser[]): string {
  if (users.length === 0) {
    return "This run seeds no users at all. Add a user fixture to your app's seed set, or turn on seed.includeExamples for the example cast.";
  }
  return `Name one of the users this run seeds instead: ${users.map((user) => user.email).join(", ")}.`;
}

/** Resolve the preference file into the user to sign in as, or fail saying who this run does seed. */
function requireUser(preferences: unknown, users: readonly SeededUser[]): SeededUser {
  const parsed = DevPreferences.safeParse(preferences);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "The dev.json preference file does not name a user.",
      action: `Set { "user": "<email>" } in it. ${nameOneOf(users)}`,
    });
  }
  const user = users.find((candidate) => candidate.email === parsed.data.user);
  if (!user) {
    throw new ValidationError({
      message: `dev.json asks to sign in as ${parsed.data.user}, which this seed run does not create.`,
      action: nameOneOf(users),
    });
  }
  return user;
}

/**
 * The dev-login seed set. Composed by the auth capability; runs only in `dev`, only for a user this same run
 * creates, and only when the developer has opted in with a `dev.json`.
 */
export const authDevSessionSeed: SeedSet = defineSeed({
  name: "dev-session",
  order: AUTH_DEV_SESSION_SEED_ORDER,
  environments: ["dev"],
  prepare: async (context): Promise<SeedPreparation> => {
    // No dev.json, no session. This is the default, and it is the one that keeps "there is no way in but
    // a magic link" true for everyone who never asked for anything else.
    if (context.preferences === undefined || context.preferences === null) return {};

    const user = requireUser(context.preferences, seededUsers(context.seeded));
    const secret = await context.secret(AUTH_SESSION_SECRET);
    if (!secret) {
      throw new ValidationError({
        message: "Cannot mint a dev session without this environment's auth secret.",
        // Never `.dev.vars` (#176). Every `d1` secret left that file in #153, and telling an adopter to
        // put one back there is telling them to undo it — the value would be inert, and the seed would
        // fail again with the same sentence. The path is deliberately unnamed rather than guessed: this
        // set runs inside a Worker with no filesystem and no config directory to resolve, and `pithy
        // doctor` prints the resolved path on every run precisely so a message like this does not have to.
        action: `Add ${AUTH_SESSION_SECRET} to this project's dev secrets file — pithy doctor prints its path — then seed again.`,
      });
    }

    const minted = await mintDevSession({ user, secret });
    return {
      d1: [d1SeedGroup("app", "pithyAuthSessions", Session, [minted.session])],
      artifacts: [{ file: DEV_LOGIN_FILE, contents: `${JSON.stringify(DevLogin.encode(minted.login), null, 2)}\n` }],
    };
  },
});
