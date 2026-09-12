// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type AuthInstanceDeps, isUnverifiedSignup, socialProviders } from "./auth";
import { NO_SOCIAL_PROVIDERS, type ResolvedProvider, type ResolvedProviders } from "./providers";

/**
 * `socialProviders()` reads only the resolved provider states on `deps`, never the database, so these
 * run as pure node tests. Every provider starts `disabled`; a case names the ones it turns on.
 */
function providers(slice: Partial<ResolvedProviders>, signUp: Partial<Record<string, boolean>> = {}) {
  return socialProviders({
    ...NO_SOCIAL_PROVIDERS,
    ...slice,
    // Every provider may create an account unless a case says otherwise — the config default.
    providerSignUp: { google: true, apple: true, facebook: true, github: true, ...signUp },
  } as unknown as AuthInstanceDeps);
}

/** A provider whose credential resolved. */
function ready<Credentials>(credentials: Credentials): ResolvedProvider<Credentials> {
  return { state: "ready", credentials };
}

/** A provider the adopter enabled whose credential would not read. */
const UNRESOLVABLE: ResolvedProvider<never> = { state: "unresolvable" };

describe("socialProviders() branch matrix", () => {
  test("no provider credentials → undefined (Google-only behavior is byte-identical when all are off)", () => {
    expect(providers({})).toBeUndefined();
  });

  test("google → the offline consent block", () => {
    expect(providers({ google: ready({ clientId: "g-id", clientSecret: "g-secret" }) })).toEqual({
      google: { clientId: "g-id", clientSecret: "g-secret", accessType: "offline", prompt: "select_account consent" },
    });
  });

  test("apple → appBundleIdentifier included when present, omitted when absent", () => {
    expect(providers({ apple: ready({ clientId: "a-id", clientSecret: "a-secret" }) })).toEqual({
      apple: { clientId: "a-id", clientSecret: "a-secret" },
    });
    expect(
      providers({ apple: ready({ clientId: "a-id", clientSecret: "a-secret", appBundleIdentifier: "com.acme.app" }) }),
    ).toEqual({
      apple: { clientId: "a-id", clientSecret: "a-secret", appBundleIdentifier: "com.acme.app" },
    });
  });

  test("facebook → requests the email scope and asserts the email as verified", () => {
    const out = providers({ facebook: ready({ clientId: "f-id", clientSecret: "f-secret" }) }) as {
      facebook: { clientId: string; clientSecret: string; scope: string[]; mapProfileToUser: () => unknown };
    };
    expect(out.facebook.clientId).toBe("f-id");
    expect(out.facebook.clientSecret).toBe("f-secret");
    expect(out.facebook.scope).toEqual(["email"]);
    // Facebook verifies emails before returning them; we assert verification so its email auto-links
    // (Better Auth defaults it to false). Facebook stays out of trustedProviders.
    expect(out.facebook.mapProfileToUser()).toEqual({ emailVerified: true });
  });

  test("github → the user:email scope and the kit's own identity resolver", () => {
    const out = providers({ github: ready({ clientId: "h-id", clientSecret: "h-secret" }) }) as never as {
      github: Record<string, unknown>;
    };
    expect(out.github.clientId).toBe("h-id");
    expect(out.github.scope).toEqual(["user:email"]);
    // The stock resolver keeps the primary and falls back to `emails[0]`, matching no existing user by
    // any other address — which is how a GitHub sign-in minted a second, empty user (#554).
    expect(typeof out.github.getUserInfo).toBe("function");
    // Sign-up is permitted unless the adopter says otherwise, so the key is absent rather than `false`:
    // asserting the opposite of Better Auth's own default is a claim nobody made.
    expect(out.github).not.toHaveProperty("disableSignUp");
  });

  test("every provider honors allowSignUp, not just the one anybody would test", () => {
    // The toggle is on the shared `ProviderToggle`, so it is writable for all four — and a policy the
    // config accepts while the instance ignores it is worse than one never offered. It shipped
    // github-only for one round, invisibly, because github is the provider this issue is about.
    const out = providers(
      {
        google: ready({ clientId: "g", clientSecret: "gs" }),
        apple: ready({ clientId: "a", clientSecret: "as" }),
        facebook: ready({ clientId: "f", clientSecret: "fs" }),
        github: ready({ clientId: "h", clientSecret: "hs" }),
      },
      { google: false, apple: false, facebook: false, github: false },
    ) as never as Record<string, Record<string, unknown>>;
    for (const id of ["google", "apple", "facebook", "github"]) {
      expect(out[id]?.disableSignUp, id).toBe(true);
    }
  });

  test("permitted sign-up asserts nothing, leaving Better Auth's own default in place", () => {
    const out = providers({
      google: ready({ clientId: "g", clientSecret: "gs" }),
      apple: ready({ clientId: "a", clientSecret: "as" }),
      facebook: ready({ clientId: "f", clientSecret: "fs" }),
      github: ready({ clientId: "h", clientSecret: "hs" }),
    }) as never as Record<string, Record<string, unknown>>;
    for (const id of ["google", "apple", "facebook", "github"]) {
      expect(out[id], id).not.toHaveProperty("disableSignUp");
    }
  });

  test("github with allowSignUp false → Better Auth's own per-provider refusal", () => {
    // The gap the dashboard fell into: it needs *email* sign-up and *no* GitHub sign-up, and one global
    // `disableSignUp` cannot say that. Better Auth reads this at callback.mjs:229.
    const out = providers(
      { github: ready({ clientId: "h-id", clientSecret: "h-secret" }) },
      { github: false },
    ) as never as {
      github: Record<string, unknown>;
    };
    expect(out.github.disableSignUp).toBe(true);
  });

  test("an adopter's resolver replaces the kit's, and nothing else about the block changes", () => {
    const mine = async () => null;
    const out = socialProviders({
      ...NO_SOCIAL_PROVIDERS,
      github: ready({ clientId: "h-id", clientSecret: "h-secret" }),
      providerSignUp: { google: true, apple: true, facebook: true, github: true },
      resolveGithubUserInfo: mine,
    } as unknown as AuthInstanceDeps) as never as { github: Record<string, unknown> };
    expect(out.github.getUserInfo).toBe(mine);
    expect(out.github.scope).toEqual(["user:email"]);
  });

  test("every provider enabled → one block per provider", () => {
    const out = providers({
      google: ready({ clientId: "g", clientSecret: "gs" }),
      apple: ready({ clientId: "a", clientSecret: "as" }),
      facebook: ready({ clientId: "f", clientSecret: "fs" }),
      github: ready({ clientId: "h", clientSecret: "hs" }),
    });
    expect(Object.keys(out ?? {}).sort()).toEqual(["apple", "facebook", "github", "google"]);
  });

  /**
   * The two ways a provider can be missing from the block, and the reason they must not be one way.
   *
   * `disabled` and `unresolvable` produce the same `socialProviders` — deliberately, because Better
   * Auth has one way to not hold a provider. What separates them is everything *around* this function:
   * `unavailableProviderFor` answers only the second, the refusal names it, and the audit trail records
   * it. If they were one state here, none of that could exist.
   */
  test("an unresolvable provider is left out, and takes none of its siblings with it", () => {
    const out = providers({
      google: ready({ clientId: "g", clientSecret: "gs" }),
      github: UNRESOLVABLE,
    });
    expect(Object.keys(out ?? {})).toEqual(["google"]);
  });

  test("every provider unresolvable → undefined, exactly as every provider disabled", () => {
    expect(
      providers({ google: UNRESOLVABLE, apple: UNRESOLVABLE, facebook: UNRESOLVABLE, github: UNRESOLVABLE }),
    ).toBeUndefined();
  });
});

describe("isUnverifiedSignup — the seeding guard predicate", () => {
  test("a provider-verified (or passwordless) sign-up is allowed", () => {
    expect(isUnverifiedSignup({ emailVerified: true })).toBe(false);
  });

  test("an unverified, missing, or null emailVerified is refused", () => {
    expect(isUnverifiedSignup({ emailVerified: false })).toBe(true);
    expect(isUnverifiedSignup({ emailVerified: undefined })).toBe(true);
    expect(isUnverifiedSignup({ emailVerified: null })).toBe(true);
    expect(isUnverifiedSignup({})).toBe(true);
  });
});
