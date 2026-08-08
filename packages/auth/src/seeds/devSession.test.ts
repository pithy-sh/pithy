// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { MAX_SEED_ORDER } from "@pithy-sh/core/src/seed/compose";
import { DEV_LOGIN_FILE, DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import { EXAMPLE_ADA, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import type { SeedPrepareContext, SeedSet } from "@pithy-sh/core/src/seed/seed";
import { collectSeededRows } from "@pithy-sh/core/src/seed/seededRows";
import { describe, expect, test } from "vitest";
import { AUTH_SESSION_SECRET } from "../instance/secrets";
import { authDevSessionSeed, DEV_SESSION_COOKIE_NAME, mintDevSession } from "./devSession";
import { authExampleSeed } from "./example";

const SECRET = "dev-secret-please-rotate-000000000000";

/** A real user of the app that adopts this kit — the case the fictional cast cannot cover. */
const APP_USER = { id: "app-jim", email: "jim@pithy.sh" };

/** An adopter's own seed set: the users it creates are as valid a dev login as any example identity. */
const appUserSeed: SeedSet = {
  name: "users",
  order: 900,
  environments: ["dev"],
  d1: [{ database: "app", table: "pithyAuthUsers", rows: [APP_USER] }],
};

/** The lookup the CLI hands `prepare`, built the way the run builds it: over the sets composed for it. */
function seededRows(...sets: readonly SeedSet[]): SeedPrepareContext["seeded"] {
  return collectSeededRows(sets);
}

/** A prepare context with the pieces the CLI supplies, each overridable per test. */
function context(overrides: Partial<SeedPrepareContext> = {}): SeedPrepareContext {
  return {
    env: "dev",
    project: "acme",
    secret: async (name) => (name === AUTH_SESSION_SECRET ? SECRET : undefined),
    preferences: { user: EXAMPLE_ADA.email },
    seeded: seededRows(authExampleSeed, appUserSeed),
    ...overrides,
  };
}

/** Run the set's prepare hook, which every test here exercises. */
function prepare(ctx: SeedPrepareContext) {
  const hook = authDevSessionSeed.prepare;
  if (!hook) throw new Error("the dev-session set must declare a prepare hook");
  return hook(ctx);
}

describe("the dev-session seed set", () => {
  test("never composes outside dev", () => {
    expect(authDevSessionSeed.environments).toEqual(["dev"]);
  });

  test("sorts after every set that could create the user it signs in as", () => {
    expect(authDevSessionSeed.order).toBe(MAX_SEED_ORDER);
  });

  test("is not an example set — a dev login must not require the fictional cast", () => {
    expect(authDevSessionSeed.example).toBeUndefined();
  });

  test("seeds nothing when the developer has no dev.json", async () => {
    const prepared = await prepare(context({ preferences: undefined }));
    expect(prepared).toEqual({});
  });

  test("mints a session and the login artifact for the named example user", async () => {
    const prepared = await prepare(context());

    expect(prepared.d1?.[0]?.table).toBe("pithyAuthSessions");
    expect(prepared.d1?.[0]?.rows).toHaveLength(1);
    expect(prepared.artifacts?.[0]?.file).toBe(DEV_LOGIN_FILE);

    const login = DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));
    expect(login.email).toBe(EXAMPLE_ADA.email);
    expect(login.userId).toBe(EXAMPLE_ADA.id);
    expect(login.cookieName).toBe(DEV_SESSION_COOKIE_NAME);
    expect(login.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("signs in as a real user the app's own seed creates, not only an example identity", async () => {
    const prepared = await prepare(context({ preferences: { user: APP_USER.email } }));

    const login = DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));
    expect(login.email).toBe(APP_USER.email);
    expect(login.userId).toBe(APP_USER.id);
  });

  test("works with the example cast off — the app's own users are the whole roster", async () => {
    const examplesOff = context({ seeded: seededRows(appUserSeed) });

    const prepared = await prepare({ ...examplesOff, preferences: { user: APP_USER.email } });
    const login = DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));
    expect(login.userId).toBe(APP_USER.id);

    // And the cast stays fictional: nothing seeds Ada, so nothing signs in as her.
    const failure = await prepare(examplesOff).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).not.toContain(EXAMPLE_ADA.email);
  });

  test("a dev.json naming a user that was not seeded fails, listing what this run does seed", async () => {
    const failure = await prepare(context({ preferences: { user: "nobody@example.com" } })).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PithyError);
    const payload = (failure as PithyError).payload;
    expect(payload.message).toContain("nobody@example.com");
    expect(payload.action).toContain(EXAMPLE_GRACE.email);
    expect(payload.action).toContain(APP_USER.email);
  });

  test("says so plainly when the run seeds no users at all", async () => {
    const failure = await prepare(context({ seeded: seededRows() })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).toContain("includeExamples");
  });

  test("a malformed dev.json fails rather than silently seeding nothing", async () => {
    const failure = await prepare(context({ preferences: { user: 7 } })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
  });

  test("an unset auth secret fails without naming a value it does not have", async () => {
    const failure = await prepare(context({ secret: async () => undefined })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).toContain(AUTH_SESSION_SECRET);
  });

  test("sends the adopter to the dev secrets file, never back to .dev.vars (#176)", async () => {
    // This message told adopters to undo #153. A `d1` secret in `.dev.vars` has been inert since then,
    // so following the advice produced the identical failure a second time — and the reader that made
    // the advice look plausible was reading the wrong file.
    const failure = await prepare(context({ secret: async () => undefined })).catch((error: unknown) => error);
    const action = (failure as PithyError).payload.action ?? "";
    expect(action).not.toContain(".dev.vars");
    expect(action).toContain("dev secrets file");
  });

  test("never puts the secret or the cookie in an error a human or a log will see", async () => {
    const minted = await mintDevSession({ user: APP_USER, secret: SECRET });
    const failures = await Promise.all(
      [{ user: "nobody@example.com" }, { user: 7 }, { user: APP_USER.email }].map((preferences) =>
        prepare(context({ preferences, seeded: seededRows(), secret: async () => undefined })).catch(
          (error: unknown) => error,
        ),
      ),
    );

    for (const failure of failures) {
      if (!(failure instanceof PithyError)) continue;
      const text = JSON.stringify(failure.payload);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(minted.login.cookieValue);
    }
  });
});

describe("mintDevSession", () => {
  test("is deterministic for one secret, so the same cookie survives a reseed", async () => {
    const first = await mintDevSession({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    const second = await mintDevSession({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_900_000_000_000) });
    expect(second.session.token).toBe(first.session.token);
    expect(second.session.id).toBe(first.session.id);
    expect(second.login.cookieValue).toBe(first.login.cookieValue);
  });

  test("rotating the secret invalidates every previously seeded cookie", async () => {
    const before = await mintDevSession({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    const after = await mintDevSession({
      user: EXAMPLE_ADA,
      secret: `${SECRET}-rotated`,
      now: new Date(1_800_000_000_000),
    });
    expect(after.session.token).not.toBe(before.session.token);
    expect(after.session.id).not.toBe(before.session.id);
    expect(after.login.cookieValue).not.toBe(before.login.cookieValue);
  });

  test("carries neither the secret nor its fingerprint in plain sight", async () => {
    const minted = await mintDevSession({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    expect(minted.session.token).not.toContain(SECRET);
    expect(minted.login.cookieValue).not.toContain(SECRET);
  });

  test("signs the cookie as `<token>.<signature>`, URI-encoded", async () => {
    const minted = await mintDevSession({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    const decoded = decodeURIComponent(minted.login.cookieValue);
    expect(decoded.startsWith(`${minted.session.token}.`)).toBe(true);
    // A base64 HMAC-SHA-256 is always 44 characters, padding included.
    expect(decoded.slice(minted.session.token.length + 1)).toHaveLength(44);
  });
});
