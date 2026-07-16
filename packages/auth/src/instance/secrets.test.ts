import { describe, expect, test } from "vitest";
import {
  AppleOAuthCredentials,
  FacebookOAuthCredentials,
  GithubOAuthCredentials,
  GoogleOAuthCredentials,
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
