// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DEV_LOGIN_FILE, DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import { EXAMPLE_ADA, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import type { SeedPrepareContext } from "@pithy-sh/core/src/seed/seed";
import { describe, expect, test } from "vitest";
import { AUTH_SESSION_SECRET } from "../instance/secrets";
import { authDevSessionSeed, DEV_SESSION_COOKIE_NAME, mintDevSession } from "./devSession";

const SECRET = "dev-secret-please-rotate-000000000000";

/** A prepare context with the pieces the CLI supplies, each overridable per test. */
function context(overrides: Partial<SeedPrepareContext> = {}): SeedPrepareContext {
  return {
    env: "dev",
    project: "acme",
    secret: async (name) => (name === AUTH_SESSION_SECRET ? SECRET : undefined),
    preferences: { user: EXAMPLE_ADA.email },
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

  test("sorts after the example set that seeds the users it signs in as", () => {
    expect(authDevSessionSeed.order).toBeGreaterThan(100);
    expect(authDevSessionSeed.example).toBe(true);
  });

  test("seeds nothing when the developer has no dev.json", async () => {
    const prepared = await prepare(context({ preferences: undefined }));
    expect(prepared).toEqual({});
  });

  test("mints a session and the login artifact for the named user", async () => {
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

  test("a dev.json naming a user that was not seeded fails with the seeded emails", async () => {
    const failure = await prepare(context({ preferences: { user: "nobody@example.com" } })).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PithyError);
    const payload = (failure as PithyError).payload;
    expect(payload.message).toContain("nobody@example.com");
    expect(payload.action).toContain(EXAMPLE_GRACE.email);
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
});

describe("mintDevSession", () => {
  test("is deterministic for one secret, so the same cookie survives a reseed", async () => {
    const first = await mintDevSession({ identity: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    const second = await mintDevSession({ identity: EXAMPLE_ADA, secret: SECRET, now: new Date(1_900_000_000_000) });
    expect(second.session.token).toBe(first.session.token);
    expect(second.session.id).toBe(first.session.id);
    expect(second.login.cookieValue).toBe(first.login.cookieValue);
  });

  test("rotating the secret invalidates every previously seeded cookie", async () => {
    const before = await mintDevSession({ identity: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    const after = await mintDevSession({
      identity: EXAMPLE_ADA,
      secret: `${SECRET}-rotated`,
      now: new Date(1_800_000_000_000),
    });
    expect(after.session.token).not.toBe(before.session.token);
    expect(after.session.id).not.toBe(before.session.id);
    expect(after.login.cookieValue).not.toBe(before.login.cookieValue);
  });

  test("carries neither the secret nor its fingerprint in plain sight", async () => {
    const minted = await mintDevSession({ identity: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    expect(minted.session.token).not.toContain(SECRET);
    expect(minted.login.cookieValue).not.toContain(SECRET);
  });

  test("signs the cookie as `<token>.<signature>`, URI-encoded", async () => {
    const minted = await mintDevSession({ identity: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    const decoded = decodeURIComponent(minted.login.cookieValue);
    expect(decoded.startsWith(`${minted.session.token}.`)).toBe(true);
    // A base64 HMAC-SHA-256 is always 44 characters, padding included.
    expect(decoded.slice(minted.session.token.length + 1)).toHaveLength(44);
  });
});
