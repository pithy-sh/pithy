import { describe, expect, test } from "vitest";
import { type AuthInstanceDeps, isUnverifiedSignup, socialProviders } from "./auth";

/**
 * `socialProviders()` reads only the resolved provider credentials on `deps`, never the database, so
 * these run as pure node tests. The cast supplies just the provider slice the function touches.
 */
function providers(slice: Partial<AuthInstanceDeps>) {
  return socialProviders(slice as unknown as AuthInstanceDeps);
}

describe("socialProviders() branch matrix", () => {
  test("no provider credentials → undefined (Google-only behavior is byte-identical when all are off)", () => {
    expect(providers({})).toBeUndefined();
  });

  test("google → the offline consent block", () => {
    expect(providers({ google: { clientId: "g-id", clientSecret: "g-secret" } })).toEqual({
      google: { clientId: "g-id", clientSecret: "g-secret", accessType: "offline", prompt: "select_account consent" },
    });
  });

  test("apple → appBundleIdentifier included when present, omitted when absent", () => {
    expect(providers({ apple: { clientId: "a-id", clientSecret: "a-secret" } })).toEqual({
      apple: { clientId: "a-id", clientSecret: "a-secret" },
    });
    expect(
      providers({ apple: { clientId: "a-id", clientSecret: "a-secret", appBundleIdentifier: "com.acme.app" } }),
    ).toEqual({
      apple: { clientId: "a-id", clientSecret: "a-secret", appBundleIdentifier: "com.acme.app" },
    });
  });

  test("facebook → requests the email scope and asserts the email as verified", () => {
    const out = providers({ facebook: { clientId: "f-id", clientSecret: "f-secret" } }) as {
      facebook: { clientId: string; clientSecret: string; scope: string[]; mapProfileToUser: () => unknown };
    };
    expect(out.facebook.clientId).toBe("f-id");
    expect(out.facebook.clientSecret).toBe("f-secret");
    expect(out.facebook.scope).toEqual(["email"]);
    // Facebook verifies emails before returning them; we assert verification so its email auto-links
    // (Better Auth defaults it to false). Facebook stays out of trustedProviders.
    expect(out.facebook.mapProfileToUser()).toEqual({ emailVerified: true });
  });

  test("github → requests the user:email scope", () => {
    expect(providers({ github: { clientId: "h-id", clientSecret: "h-secret" } })).toEqual({
      github: { clientId: "h-id", clientSecret: "h-secret", scope: ["user:email"] },
    });
  });

  test("every provider enabled → one block per provider", () => {
    const out = providers({
      google: { clientId: "g", clientSecret: "gs" },
      apple: { clientId: "a", clientSecret: "as" },
      facebook: { clientId: "f", clientSecret: "fs" },
      github: { clientId: "h", clientSecret: "hs" },
    });
    expect(Object.keys(out ?? {}).sort()).toEqual(["apple", "facebook", "github", "google"]);
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
