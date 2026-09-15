// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, expectTypeOf, test } from "vitest";
import { isBindingName, secretBindingName } from "./bindingName";

describe("secretBindingName (#603)", () => {
  test("a kebab-case registry key binds in SCREAMING_SNAKE_CASE", () => {
    expect(secretBindingName("email-link-signing-key")).toBe("EMAIL_LINK_SIGNING_KEY");
  });

  test("a key already in the binding shape maps to itself", () => {
    expect(secretBindingName("CLOUDFLARE_API_TOKEN")).toBe("CLOUDFLARE_API_TOKEN");
    expect(secretBindingName("SECRETS_ENCRYPTION_KEYS")).toBe("SECRETS_ENCRYPTION_KEYS");
    expect(secretBindingName("R2ACCESS_KEY")).toBe("R2ACCESS_KEY");
  });

  test("every character that is not an ASCII letter or digit is an underscore, and nothing else moves", () => {
    // One rule, applied character by character: no word boundary is inferred anywhere, so a separator
    // becomes an underscore where it stands and a digit stays where it is.
    expect(secretBindingName("R2ACCESS-KEY")).toBe("R2ACCESS_KEY");
    expect(secretBindingName("oauth2-client")).toBe("OAUTH2_CLIENT");
    expect(secretBindingName("media.r2 credentials")).toBe("MEDIA_R2_CREDENTIALS");
    expect(secretBindingName("a--b")).toBe("A__B");
    expect(secretBindingName("clé")).toBe("CL_");
  });

  test("camelCase is not split — no kit key is camelCase, and a guessed boundary is a second rule", () => {
    expect(secretBindingName("stripeWebhookKey")).toBe("STRIPEWEBHOOKKEY");
    expect(secretBindingName("NPMToken")).toBe("NPMTOKEN");
  });

  test("it is idempotent", () => {
    for (const name of [
      "email-link-signing-key",
      "stripeWebhookKey",
      "CLOUDFLARE_API_TOKEN",
      "a-b-c",
      "R2ACCESS-KEY",
    ]) {
      expect(secretBindingName(secretBindingName(name))).toBe(secretBindingName(name));
    }
  });

  test("isBindingName accepts only what a Worker can bind", () => {
    expect(isBindingName("EMAIL_LINK_SIGNING_KEY")).toBe(true);
    expect(isBindingName("_PRIVATE")).toBe(true);
    expect(isBindingName("email-link-signing-key")).toBe(false);
    expect(isBindingName("2FA_KEY")).toBe(false);
    expect(isBindingName("")).toBe(false);
  });
});

describe("SecretBindingName — the same answer as a type", () => {
  test("the literal type is what the function returns, for every shape of key", () => {
    expectTypeOf(secretBindingName("email-link-signing-key")).toEqualTypeOf<"EMAIL_LINK_SIGNING_KEY">();
    expectTypeOf(secretBindingName("CLOUDFLARE_API_TOKEN")).toEqualTypeOf<"CLOUDFLARE_API_TOKEN">();
    // The two cases the earlier type disagreed with the runtime on.
    expectTypeOf(secretBindingName("R2ACCESS-KEY")).toEqualTypeOf<"R2ACCESS_KEY">();
    expectTypeOf(secretBindingName("stripeWebhookKey")).toEqualTypeOf<"STRIPEWEBHOOKKEY">();
    expectTypeOf(secretBindingName("media.r2 credentials")).toEqualTypeOf<"MEDIA_R2_CREDENTIALS">();
    expect(secretBindingName("R2ACCESS-KEY")).toBe("R2ACCESS_KEY");
  });

  test("a long key still types, rather than exhausting the checker", () => {
    const key = "payments-webhook-signing-secret-for-the-production-environment-of-this-project";
    expectTypeOf(
      secretBindingName(key),
    ).toEqualTypeOf<"PAYMENTS_WEBHOOK_SIGNING_SECRET_FOR_THE_PRODUCTION_ENVIRONMENT_OF_THIS_PROJECT">();
    expect(secretBindingName(key)).toBe(key.toUpperCase().replaceAll("-", "_"));
  });

  test("a key that is only a string is typed as a string", () => {
    const key: string = "email-link-signing-key";
    expectTypeOf(secretBindingName(key)).toEqualTypeOf<string>();
  });
});
