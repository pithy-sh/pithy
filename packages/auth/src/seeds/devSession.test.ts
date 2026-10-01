// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { MAX_SEED_ORDER } from "@pithy-sh/core/src/seed/compose";
import { DEV_LOGIN_FILE, DevLogins } from "@pithy-sh/core/src/seed/devLogin";
import { EXAMPLE_ADA, EXAMPLE_GRACE, EXAMPLE_IDENTITIES } from "@pithy-sh/core/src/seed/exampleIdentities";
import type { SeedPrepareContext, SeedSet } from "@pithy-sh/core/src/seed/seed";
import { collectSeededRows } from "@pithy-sh/core/src/seed/seededRows";
import { describe, expect, test } from "vitest";
import { AUTH_SESSION_SECRET } from "../instance/secrets";
import { authDevSessionSeed, mintDevLogin, mintDevLogins, verifyDevLoginClaim } from "./devSession";
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
    // This set seals nothing at creation time, so it asks the run for nothing it just minted (#660).
    mintedThisRun: () => undefined,
    preferences: { user: EXAMPLE_ADA.email },
    seeded: seededRows(authExampleSeed, appUserSeed),
    ...overrides,
  };
}

/** The artifact this run wrote, parsed — a record now, keyed by user id (`#667`). */
function written(prepared: { artifacts?: readonly { file: string; contents: string }[] }): DevLogins {
  return DevLogins.parse(JSON.parse(prepared.artifacts?.[0]?.contents ?? "{}"));
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

  test("**mints one entry per seeded user**, keyed by user id, and no rows at all", async () => {
    // `#667`. The source is the seeded auth rows, so an adopter's own seed set yields their own users —
    // the canonical cast is only what `seed.includeExamples` happens to add to them.
    //
    // **No `d1` — `#572`.** A seeded session was what the product's own sign-out revoked, taking the dev
    // login with it. The set writes a file; the route mints the session when somebody opens the link.
    const prepared = await prepare(context());
    expect(prepared.d1).toBeUndefined();
    expect(prepared.artifacts?.[0]?.file).toBe(DEV_LOGIN_FILE);

    const logins = written(prepared);
    expect(Object.keys(logins).sort()).toEqual([APP_USER.id, ...EXAMPLE_IDENTITIES.map((i) => i.id)].sort());
    expect(logins[EXAMPLE_ADA.id]?.email).toBe(EXAMPLE_ADA.email);
    expect(logins[APP_USER.id]?.email).toBe(APP_USER.email);
    for (const [userId, entry] of Object.entries(logins)) {
      expect(entry.userId).toBe(userId);
      expect(entry.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  test("every claim verifies against this environment's secret and names its own user", async () => {
    // The property that makes N claims worth minting: each one is a signature over one user id, so the
    // route exchanges it for that user's session and nobody else's.
    for (const entry of Object.values(written(await prepare(context())))) {
      expect(await verifyDevLoginClaim(entry.claim, SECRET)).toMatchObject({ userId: entry.userId });
    }
  });

  test("no two users share a claim", async () => {
    const claims = Object.values(written(await prepare(context()))).map((entry) => entry.claim);
    expect(new Set(claims).size).toBe(claims.length);
  });

  test("signs in as a real user the app's own seed creates, not only an example identity", async () => {
    const logins = written(await prepare(context()));
    expect(logins[APP_USER.id]?.email).toBe(APP_USER.email);
  });

  test("**the user dev.json names comes first**, because the record's order is the picker's", () => {
    // The field's remaining job. It no longer decides who gets a claim — everybody does — so what is left
    // is which identity `l` offers first, which is what somebody who bothered to write the file wanted.
    return prepare(context({ preferences: { user: APP_USER.email } })).then((prepared) => {
      expect(Object.keys(written(prepared))[0]).toBe(APP_USER.id);
    });
  });

  test("**a dev.json naming no user mints nothing** — the key is the opt-in, not the file", async () => {
    // `dev.json` is a multi-tenant file (`#154`), and `pithy dev` creates it for bootstrap `.dev.vars`
    // alone. So the *file* cannot be the opt-in: a machine that had vars written would silently get a live
    // claim for every seeded user without anybody asking for a dev login. `doctor/devPreferences.ts` says
    // the same thing — `user` is "the one key a dev-login preference file must carry".
    expect(await prepare(context({ preferences: {} }))).toEqual({});
  });

  test("another tenant's dev.json is not a dev-login opt-in, and does not fail the seed either", async () => {
    // The concrete case: `writeBootstrapVars` wrote `{ pithyBootstrapVars: … }` and nothing else. It is a
    // valid file belonging to somebody else, so it mints nothing — and it is not malformed, so it throws
    // nothing. Extra keys pass, exactly as the file's own schema and doctor's both hold.
    expect(await prepare(context({ preferences: { pithyBootstrapVars: { SOME_VAR: "value" } } }))).toEqual({});
  });

  test("works with the example cast off — the app's own users are the whole roster", async () => {
    const examplesOff = context({ seeded: seededRows(appUserSeed) });

    const prepared = await prepare({ ...examplesOff, preferences: { user: APP_USER.email } });
    expect(Object.keys(written(prepared))).toEqual([APP_USER.id]);

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

describe("mintDevLogins", () => {
  const CAST = [EXAMPLE_ADA, EXAMPLE_GRACE, APP_USER];

  test("keys every user by id and **keeps the order it was handed**", async () => {
    // The order is the picker's, so it is the caller's to decide and this must not sort or rebuild it.
    const minted = await mintDevLogins({ users: CAST, secret: SECRET });
    expect(Object.keys(minted)).toEqual([EXAMPLE_ADA.id, EXAMPLE_GRACE.id, APP_USER.id]);
    expect(minted[EXAMPLE_GRACE.id]?.email).toBe(EXAMPLE_GRACE.email);
  });

  test("mints each entry exactly as minting one would", async () => {
    // One claim per user, from the same function — so a fix to how a claim is signed cannot reach one
    // path and miss the other.
    const at = new Date(1_800_000_000_000);
    const minted = await mintDevLogins({ users: [EXAMPLE_ADA], secret: SECRET, now: at });
    expect(minted[EXAMPLE_ADA.id]).toEqual((await mintDevLogin({ user: EXAMPLE_ADA, secret: SECRET, now: at })).login);
  });

  test("**an integer-like user id is enumerated numerically, whatever order it was handed in**", async () => {
    // Not our choice and not fixable in a record: JS enumerates canonical array-index keys first, in
    // ascending numeric order, and `JSON.parse` does the same on the way back in. An adopter whose users
    // carry stringified integer PKs therefore gets a numerically ordered picker, and `dev.json`'s "offered
    // first" does not survive for them. Pinned rather than left to be discovered, because the artifact is
    // keyed by user id by design and the alternative is a different artifact shape.
    const numeric = [
      { id: "3", email: "three@example.com" },
      { id: "1", email: "one@example.com" },
    ];
    expect(Object.keys(await mintDevLogins({ users: numeric, secret: SECRET }))).toEqual(["1", "3"]);
  });

  test("no users is an empty record, not a failure — the caller owns that refusal", async () => {
    expect(await mintDevLogins({ users: [], secret: SECRET })).toEqual({});
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
