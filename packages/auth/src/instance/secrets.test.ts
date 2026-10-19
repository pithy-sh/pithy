// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import { describe, expect, test } from "vitest";
import { auth } from "../capability";
import {
  AppleOAuthCredentials,
  AUTH_APPLE_CREDENTIALS,
  AUTH_FACEBOOK_CREDENTIALS,
  AUTH_GITHUB_CREDENTIALS,
  AUTH_GOOGLE_CREDENTIALS,
  AUTH_JWKS_DEPENDENT,
  AUTH_SESSION_SECRET,
  authSecretsRegistry,
  authSecretsRegistryFor,
  FacebookOAuthCredentials,
  GithubOAuthCredentials,
  GoogleOAuthCredentials,
  inapplicableProviderSecrets,
  sessionSecretOverlapDays,
} from "./secrets";

/**
 * The provider credential secrets are typed JSON, validated on read and write through their Zod
 * schema. Each round-trips: parse the stored JSON shape and get the same value back.
 */
describe("provider credential codecs", () => {
  test("Google credentials round-trip", () => {
    const value = { clientId: "g-id", clientSecret: "g-secret" };
    expect(GoogleOAuthCredentials.parse(value)).toEqual(value);
  });

  test("Apple credentials round-trip, with and without appBundleIdentifier", () => {
    const bare = { clientId: "a-id", clientSecret: "a-secret" };
    expect(AppleOAuthCredentials.parse(bare)).toEqual(bare);
    const withBundle = { ...bare, appBundleIdentifier: "com.acme.app" };
    expect(AppleOAuthCredentials.parse(withBundle)).toEqual(withBundle);
  });

  test("Facebook credentials round-trip", () => {
    const value = { clientId: "f-id", clientSecret: "f-secret" };
    expect(FacebookOAuthCredentials.parse(value)).toEqual(value);
  });

  test("GitHub credentials round-trip", () => {
    const value = { clientId: "h-id", clientSecret: "h-secret" };
    expect(GithubOAuthCredentials.parse(value)).toEqual(value);
  });

  test("a credential missing its secret is rejected at the boundary", () => {
    expect(() => FacebookOAuthCredentials.parse({ clientId: "f-id" })).toThrow();
    expect(() => GithubOAuthCredentials.parse({ clientId: "h-id" })).toThrow();
  });
});

/**
 * **Which provider credentials this composition cannot reach (#541).**
 *
 * Auth declares one credential per provider whether or not the project runs that provider, so a project
 * on Google and GitHub carries two secrets no code path will ever read. `pithy doctor` listed both as
 * outstanding — under *"fine to leave until you need it"*, which is wrong for a credential the
 * configuration has already refused — and `pithy secrets ls` showed them with nothing saying so.
 *
 * The capability holds both halves at construction and states the answer. Nothing infers it from the
 * names: `auth-apple-credentials` and `apple` are spelled alike by coincidence.
 */
describe("inapplicableProviderSecrets", () => {
  test("names every provider that is off, and says which config key turns it on", () => {
    const off = inapplicableProviderSecrets({
      google: { enabled: true },
      apple: { enabled: false },
      facebook: { enabled: false },
      github: { enabled: true },
    });
    expect(Object.keys(off).sort()).toEqual([AUTH_APPLE_CREDENTIALS, AUTH_FACEBOOK_CREDENTIALS]);
    expect(off[AUTH_APPLE_CREDENTIALS]).toBe("auth() does not enable the apple provider");
  });

  /** The session secret is read on every sign-in whatever the providers are, so it is never in here. */
  test("never names the session secret", () => {
    const all = inapplicableProviderSecrets({
      google: { enabled: false },
      apple: { enabled: false },
      facebook: { enabled: false },
      github: { enabled: false },
    });
    expect(Object.keys(all)).not.toContain(AUTH_SESSION_SECRET);
    expect(Object.keys(all).sort()).toEqual(
      [AUTH_APPLE_CREDENTIALS, AUTH_FACEBOOK_CREDENTIALS, AUTH_GITHUB_CREDENTIALS, AUTH_GOOGLE_CREDENTIALS].sort(),
    );
  });

  /** Every provider on is an empty declaration — the shape that says *everything here applies*. */
  test("declares nothing when every provider is enabled", () => {
    expect(
      inapplicableProviderSecrets({
        google: { enabled: true },
        apple: { enabled: true },
        facebook: { enabled: true },
        github: { enabled: true },
      }),
    ).toEqual({});
  });

  /**
   * Every name it can produce is a name the registry declares. A typo here would be a reason attached
   * to nothing, and nothing downstream could tell that from a secret that genuinely applies.
   */
  test("every name it can name is one this capability declares", () => {
    const all = inapplicableProviderSecrets({
      google: { enabled: false },
      apple: { enabled: false },
      facebook: { enabled: false },
      github: { enabled: false },
    });
    for (const name of Object.keys(all)) expect(Object.keys(authSecretsRegistry)).toContain(name);
  });
});

/** The capability hangs the declaration on the contract, which is the only place the CLI reads. */
describe("auth().inapplicableSecrets", () => {
  test("carries the disabled providers", () => {
    const composed = auth({ baseURL: "https://example.com", google: { enabled: true } });
    expect(composed.inapplicableSecrets?.[AUTH_GOOGLE_CREDENTIALS]).toBeUndefined();
    expect(composed.inapplicableSecrets?.[AUTH_APPLE_CREDENTIALS]).toBe("auth() does not enable the apple provider");
  });
});

describe("the session secret's unattended rotation (#602)", () => {
  const WEEK = 60 * 60 * 24 * 7;

  test("its overlap is the session lifetime, rounded up to whole days, and that lifetime is also its floor", () => {
    expect(sessionSecretOverlapDays(WEEK)).toBe(7);
    expect(sessionSecretOverlapDays(WEEK + 1)).toBe(8);
    expect(sessionSecretOverlapDays(60)).toBe(1);
    const registry = authSecretsRegistryFor({ sessionExpiresIn: 30 * 86_400 });
    expect(registry[AUTH_SESSION_SECRET].overlap).toEqual({
      days: 30,
      minimumDays: 30,
      reencrypt: [AUTH_JWKS_DEPENDENT],
    });
  });

  test("the kit turns nothing on: no period unless the adopter asks for one", () => {
    expect(authSecretsRegistryFor({ sessionExpiresIn: WEEK })[AUTH_SESSION_SECRET].rotateEveryDays).toBeUndefined();
    expect(authSecretsRegistry[AUTH_SESSION_SECRET]).not.toHaveProperty("rotateEveryDays");
    expect(auth({ baseURL: "https://api.example.com" }).secretRegistry?.[AUTH_SESSION_SECRET]).not.toHaveProperty(
      "rotateEveryDays",
    );
  });

  test("auth({ sessionSecretRotateEveryDays }) is the period the secrets manager rotates it on", () => {
    const capability = auth({ baseURL: "https://api.example.com", sessionSecretRotateEveryDays: 90 });
    expect(capability.secretRegistry?.[AUTH_SESSION_SECRET]).toMatchObject({
      rotateEveryDays: 90,
      overlap: { days: 7, minimumDays: 7, reencrypt: [AUTH_JWKS_DEPENDENT] },
    });
  });

  test("twoFactor() with a period is refused at auth(): its secrets are sealed under the session secret, and nothing moves them", () => {
    const composing = () =>
      auth({ baseURL: "https://api.example.com", sessionSecretRotateEveryDays: 90, plugins: [twoFactor()] });
    expect(composing).toThrow(PithyError);
    expect(composing).toThrow(/two-factor/);
    expect(() =>
      authSecretsRegistryFor({ sessionExpiresIn: WEEK, sessionSecretRotateEveryDays: 90, plugins: [twoFactor()] }),
    ).toThrow(/auth-session-secret/);
  });

  test("twoFactor() with no period, or a period with plugins that seal nothing, composes as before", () => {
    expect(() => auth({ baseURL: "https://api.example.com", plugins: [twoFactor()] })).not.toThrow();
    expect(() =>
      auth({ baseURL: "https://api.example.com", sessionSecretRotateEveryDays: 90, plugins: [organization()] }),
    ).not.toThrow();
  });

  test("a period no longer than the session lifetime is refused at auth(), naming the secret", () => {
    expect(() => auth({ baseURL: "https://api.example.com", sessionSecretRotateEveryDays: 7 })).toThrow(
      /auth-session-secret/,
    );
  });
});
