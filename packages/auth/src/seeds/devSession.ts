// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { fromZodError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { MAX_SEED_ORDER } from "@pithy-sh/core/src/seed/compose";
import { DEV_LOGIN_PATH, DevLogin, devLoginFileFor } from "@pithy-sh/core/src/seed/devLogin";
import { defineSeed, type SeedPreparation, type SeedPrepareContext, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { z } from "zod";
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
 * - `environments: ["dev", "feature"]` — it can never be composed into staging or production. A feature
 *   deployment is the one deployed host it reaches (#643): throwaway, owned by one branch, and signed into by
 *   the people building it. Its login is written as `dev-login.feature.json`, so seeding it from the feature's
 *   worktree never overwrites the local login `pithy dev` reads there.
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
 * How long a dev login stays usable. Long, because reseeding to restore one is the friction this removes.
 *
 * It bounds the *claim*, not a session — `#572`. The session the route mints from it lives by the auth
 * config's own `sessionExpiresIn`, exactly as a real sign-in does, because it *is* one.
 */
const DEV_LOGIN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

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

/** What {@link mintDevLogin} produces. One field, because a dev login is no longer a row — `#572`. */
export interface MintedDevLogin {
  /** The dev-login artifact, written to `logs/dev-login.json`. */
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

/** Inputs to {@link mintDevLogin}. `now` is a seam so the tests do not depend on the clock. */
export interface MintDevLoginInput {
  /** The seeded user to sign in as. */
  user: SeededUser;
  /** The Better Auth signing secret for this environment — never logged, never stored, never in an error. */
  secret: string;
  /** The moment the claim is minted. Defaults to now. */
  now?: Date;
}

/**
 * Sign a claim naming the user a dev login signs in as — `#572`.
 *
 * **The payload is base64 of JSON, not a delimited string.** A user id is an adopter's to choose and may
 * hold any character at all, including whichever one a hand-rolled format picked as its separator. JSON
 * inside base64 has no separator to collide with, and the whole of it is what the signature covers.
 *
 * The same HMAC-SHA-256 construction {@link signCookieValue} uses, deliberately not the same function:
 * that one mirrors better-call's cookie format because Better Auth has to accept its output, and this is
 * ours. Two consumers, two formats, no shared spelling to break one by fixing the other.
 */
export async function signDevLoginClaim(input: MintDevLoginInput & { expiresAt: Date }): Promise<string> {
  // **`TextEncoder`, not `btoa` on the string.** `btoa` throws `InvalidCharacterError` for any code
  // point above U+00FF, and a user id is the adopter's to choose — this module already reasons about
  // ids holding a separator, and a non-ASCII one is no stranger. Encoding to UTF-8 bytes first makes
  // the payload total in the id, which is what a seed that must not die on somebody's name requires.
  const body = base64Of(new TextEncoder().encode(JSON.stringify({ u: input.user.id, e: input.expiresAt.getTime() })));
  const key = await claimKey(input.secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return encodeURIComponent(`${body}.${base64Of(signature)}`);
}

/**
 * What a claim says, once it has been proved to say it.
 *
 * `null` for every failure and never a reason: a malformed claim, one signed by another secret, and one
 * naming a user who has since gone are the same answer to whoever presented it, because distinguishing
 * them is a probe. The route turns all three into the one 404 it already had.
 */
export async function verifyDevLoginClaim(
  claim: string,
  secret: string,
  now: Date = new Date(),
): Promise<{ userId: string; expiresAt: Date } | null> {
  const raw = safeDecode(claim);
  if (raw === null) return null;
  // The last dot, because base64 never contains one and a payload might have been anything.
  const cut = raw.lastIndexOf(".");
  if (cut <= 0) return null;
  const body = raw.slice(0, cut);
  const signature = safeBytes(raw.slice(cut + 1));
  if (signature === null) return null;

  // `crypto.subtle.verify` rather than comparing strings: the comparison is the part that has to be
  // constant-time, and this is the primitive that already is.
  const key = await claimKey(secret, ["verify"]);
  if (!(await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(body)))) return null;

  const decoded = safeJson(body);
  const parsed = DevLoginClaim.safeParse(decoded);
  if (!parsed.success) return null;
  const expiresAt = new Date(parsed.data.e);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return { userId: parsed.data.u, expiresAt };
}

/** The claim's payload, as it is signed. Two letters, because it is written into a URL a person may see. */
const DevLoginClaim = z
  .object({
    u: z.string().min(1).describe("The user id the route mints a session for."),
    e: z.number().int().positive().describe("When the claim stops being accepted, in ms since the epoch."),
  })
  .describe("What a dev-login claim asserts: which seeded user, and until when.");

/** The HMAC key for a claim. Imported per call — a key object is not something to cache across requests. */
function claimKey(secret: string, usages: readonly ("sign" | "verify")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    ...usages,
  ]);
}

/** Base64 of bytes — a signature, or a UTF-8 payload. */
function base64Of(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

/** `decodeURIComponent`, or null. A malformed escape throws, and a throw here is just "not a claim". */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Base64 to bytes, or null. Same reason: unparseable input is not an error, it is a refusal. */
function safeBytes(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Base64 UTF-8 JSON to a value, or null. Decoded as bytes, to match how {@link base64Of} wrote it. */
function safeJson(body: string): unknown {
  try {
    const bytes = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Mint one dev login: the signed claim, and the artifact that carries it.
 *
 * **No `pithy_auth_sessions` row — `#572`.** This used to write one and hand it over on every open, which
 * meant the product's own sign-out revoked the dev login along with the session, and the only way back was
 * a reseed. It also meant a row in that table which was, by this module's own admission, indistinguishable
 * from a real sign-in — so it showed up in every surface built over sessions as a device nobody used.
 *
 * What is minted here is a claim about *who*. The route exchanges it for a session at the moment somebody
 * opens the link, so the session is real, is theirs, and is the only thing a sign-out takes away.
 */
export async function mintDevLogin(input: MintDevLoginInput): Promise<MintedDevLogin> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + DEV_LOGIN_LIFETIME_MS);
  return {
    login: {
      email: input.user.email,
      userId: input.user.id,
      claim: await signDevLoginClaim({ ...input, expiresAt }),
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
  // Both sides normalized: `dev.json` is hand-typed, and refusing to sign in over the capital in
  // `Ada@example.com` would be a puzzle rather than an error.
  const wanted = normalizeAddress(parsed.data.user);
  const user = users.find((candidate) => normalizeAddress(candidate.email) === wanted);
  if (!user) {
    throw new ValidationError({
      message: `dev.json asks to sign in as ${parsed.data.user}, which this seed run does not create.`,
      action: nameOneOf(users),
    });
  }
  return user;
}

/**
 * The dev-login seed set. Composed by the auth capability; runs only in `dev` and on a feature deployment, only
 * for a user this same run creates, and only when the developer has opted in with a `dev.json`.
 */
export const authDevSessionSeed: SeedSet = defineSeed({
  name: "dev-session",
  order: AUTH_DEV_SESSION_SEED_ORDER,
  environments: ["dev", "feature"],
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

    const minted = await mintDevLogin({ user, secret });
    // Where it opens, when this run knows (#643): off `dev` there is no pinned port to compose a link from, so
    // the login carries its deployment's origin and `pithy seed` prints the link over it.
    const login =
      context.origin !== null && context.env !== "dev" ? { ...minted.login, origin: context.origin } : minted.login;
    // **No `d1` — `#572`.** This set writes a file and nothing else now. Nothing reaches
    // `pithy_auth_sessions` until somebody opens the link and the route mints a session for them, which
    // is what makes signing out of the app harmless to the way back in.
    return {
      artifacts: [
        { file: devLoginFileFor(context.env), contents: `${JSON.stringify(DevLogin.encode(login), null, 2)}\n` },
      ],
    };
  },
});
