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
import { authDevSessionSeed, mintDevLogin, verifyDevLoginClaim } from "./devSession";
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
    // `null`, never a port literal: this set's cookie deliberately excludes host and port, so a literal
    // here would plant the very fixture #458 is about while proving nothing.
    origin: null,
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
  /**
   * `dev`, and a feature deployment (#643) — the one throwaway host where a mail round trip to sign in is pure
   * friction. Never a declared environment: `staging` and `prod` hold real users, and no seed signs anyone in.
   */
  test("composes into dev and a feature, and never into a declared environment", () => {
    expect(authDevSessionSeed.environments).toEqual(["dev", "feature"]);
    for (const declared of ["staging", "prod", "production"]) {
      expect(authDevSessionSeed.environments).not.toContain(declared);
    }
  });

  /**
   * A feature seed runs from the feature's own worktree, where `pithy dev` reads `logs/dev-login.json`. The
   * feature's login is named for the feature, so seeding the deployment never overwrites the local one.
   */
  test("names a feature's login for the feature, never over dev's", async () => {
    const prepared = await prepare(context({ env: "feature" }));

    expect(prepared.artifacts?.[0]?.file).toBe("dev-login.feature.json");
    expect(prepared.artifacts?.[0]?.file).not.toBe(DEV_LOGIN_FILE);
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

  test("mints the login artifact for the named example user, and no rows at all", async () => {
    const prepared = await prepare(context());

    // **No `d1` — `#572`.** A seeded session was what the product's own sign-out revoked, taking the dev
    // login with it. The set writes a file; the route mints the session when somebody opens the link.
    expect(prepared.d1).toBeUndefined();
    expect(prepared.artifacts?.[0]?.file).toBe(DEV_LOGIN_FILE);

    const login = DevLogin.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));
    expect(login.email).toBe(EXAMPLE_ADA.email);
    expect(login.userId).toBe(EXAMPLE_ADA.id);
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

  test("never puts the secret or the claim in an error a human or a log will see", async () => {
    const minted = await mintDevLogin({ user: APP_USER, secret: SECRET });
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
      expect(text).not.toContain(minted.login.claim);
    }
  });
});

describe("mintDevLogin", () => {
  test("is deterministic for one secret and one moment, so a reseed is not a new login", async () => {
    const at = new Date(1_800_000_000_000);
    const first = await mintDevLogin({ user: EXAMPLE_ADA, secret: SECRET, now: at });
    const second = await mintDevLogin({ user: EXAMPLE_ADA, secret: SECRET, now: at });
    expect(second.login.claim).toBe(first.login.claim);
  });

  test("a claim verifies against the secret that signed it, and names the user it was minted for", async () => {
    const minted = await mintDevLogin({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    expect(await verifyDevLoginClaim(minted.login.claim, SECRET, new Date(1_800_000_001_000))).toEqual({
      userId: EXAMPLE_ADA.id,
      expiresAt: minted.login.expiresAt,
    });
  });

  test("rotating the secret refuses every claim minted under the old one", async () => {
    const minted = await mintDevLogin({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    expect(await verifyDevLoginClaim(minted.login.claim, `${SECRET}-rotated`)).toBeNull();
  });

  test("carries neither the secret nor the user's address in plain sight", async () => {
    const minted = await mintDevLogin({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    expect(minted.login.claim).not.toContain(SECRET);
  });

  test("signs the claim as `<payload>.<signature>`, URI-encoded", async () => {
    const minted = await mintDevLogin({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    const decoded = decodeURIComponent(minted.login.claim);
    const cut = decoded.lastIndexOf(".");
    expect(cut).toBeGreaterThan(0);
    // A base64 HMAC-SHA-256 is always 44 characters, padding included.
    expect(decoded.slice(cut + 1)).toHaveLength(44);
  });
});

describe("verifyDevLoginClaim", () => {
  /** One claim, minted the ordinary way, for the refusals below to mutate. */
  async function claim(): Promise<string> {
    return (await mintDevLogin({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) })).login.claim;
  }

  test("**every refusal is null — nothing tells them apart**", async () => {
    // A route that answered differently for "malformed", "wrong secret" and "expired" would be a probe
    // against the running secret. One answer, and the route turns it into the one 404 it already had.
    const good = await claim();
    const decoded = decodeURIComponent(good);
    const cut = decoded.lastIndexOf(".");

    for (const [name, presented] of [
      ["empty", ""],
      ["not a claim at all", "hello"],
      ["no signature", encodeURIComponent(decoded.slice(0, cut))],
      [
        "a tampered payload",
        encodeURIComponent(
          `${btoa(JSON.stringify({ u: "somebody-else", e: 4_000_000_000_000 }))}.${decoded.slice(cut + 1)}`,
        ),
      ],
      ["a signature that is not base64", encodeURIComponent(`${decoded.slice(0, cut)}.not-base64!`)],
      ["a malformed escape", "%E0%A4%A"],
    ] as const) {
      expect(await verifyDevLoginClaim(presented, SECRET), name).toBeNull();
    }
  });

  test("an expired claim is refused, and its own expiry is what decides", async () => {
    const minted = await mintDevLogin({ user: EXAMPLE_ADA, secret: SECRET, now: new Date(1_800_000_000_000) });
    const justBefore = new Date(minted.login.expiresAt.getTime() - 1_000);
    const after = new Date(minted.login.expiresAt.getTime() + 1_000);
    expect(await verifyDevLoginClaim(minted.login.claim, SECRET, justBefore)).not.toBeNull();
    expect(await verifyDevLoginClaim(minted.login.claim, SECRET, after)).toBeNull();
  });

  test("a user id outside Latin-1 round-trips, because the payload is encoded as UTF-8 bytes", async () => {
    // `btoa` on the JSON string threw `InvalidCharacterError` above U+00FF, and a user id is the
    // adopter's to choose. A seed must not die on somebody's name.
    const named = { id: "user-Ωменя-日本", email: "omega@example.com" };
    const minted = await mintDevLogin({ user: named, secret: SECRET, now: new Date(1_800_000_000_000) });
    expect((await verifyDevLoginClaim(minted.login.claim, SECRET))?.userId).toBe(named.id);
  });

  test("a user id holding the separator round-trips, because the payload is base64 of JSON", async () => {
    // An adopter picks their own user ids. A delimited payload would have split this one in the middle.
    const awkward = { id: 'a.b|c:d"e', email: "awkward@example.com" };
    const minted = await mintDevLogin({ user: awkward, secret: SECRET, now: new Date(1_800_000_000_000) });
    expect((await verifyDevLoginClaim(minted.login.claim, SECRET))?.userId).toBe(awkward.id);
  });
});
