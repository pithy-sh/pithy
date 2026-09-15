// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { isBindingName, secretBindingName } from "./bindingName";

describe("secretBindingName (#603)", () => {
  test("a kebab-case registry key binds in SCREAMING_SNAKE_CASE", () => {
    expect(secretBindingName("email-link-signing-key")).toBe("EMAIL_LINK_SIGNING_KEY");
  });

  test("a key already in the binding shape maps to itself", () => {
    expect(secretBindingName("CLOUDFLARE_API_TOKEN")).toBe("CLOUDFLARE_API_TOKEN");
    expect(secretBindingName("SECRETS_ENCRYPTION_KEYS")).toBe("SECRETS_ENCRYPTION_KEYS");
    // A digit before a capital is a word boundary in camelCase, and nothing at all in a name already bound.
    expect(secretBindingName("R2ACCESS_KEY")).toBe("R2ACCESS_KEY");
  });

  test("digits are kept, and a camelCase word boundary becomes an underscore", () => {
    expect(secretBindingName("oauth2-client")).toBe("OAUTH2_CLIENT");
    expect(secretBindingName("stripeWebhookKey")).toBe("STRIPE_WEBHOOK_KEY");
    expect(secretBindingName("media.r2 credentials")).toBe("MEDIA_R2_CREDENTIALS");
  });

  test("it is idempotent", () => {
    for (const name of ["email-link-signing-key", "stripeWebhookKey", "CLOUDFLARE_API_TOKEN", "a-b-c"]) {
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
  test("a kebab-case or already-bound key is typed as its binding", () => {
    const link: "EMAIL_LINK_SIGNING_KEY" = secretBindingName("email-link-signing-key");
    const token: "CLOUDFLARE_API_TOKEN" = secretBindingName("CLOUDFLARE_API_TOKEN");
    expect([link, token]).toEqual(["EMAIL_LINK_SIGNING_KEY", "CLOUDFLARE_API_TOKEN"]);
  });
});
