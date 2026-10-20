// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { admitsRefusedAccount, lifecycleRedirect } from "./lifecycleGate";

const suspended = new PithyError({
  code: "auth/account_suspended",
  status: 403,
  message: "Chargeback under review.",
});

describe("admitsRefusedAccount — which Better Auth endpoints a suspended account's credential may still reach", () => {
  test.each([
    "/sign-out",
    "/sign-in/magic-link",
    "/sign-in/email-otp",
    "/sign-in/social",
    "/magic-link/verify",
    "/email-otp/send-verification-otp",
    "/callback/google",
    "/oauth2/callback/acme",
    "/jwks",
    "/ok",
    "/error",
  ])("%s — it does not act as the account the credential names", (path) => {
    // Signing out must always work, and a credential left on a shared device must not stop somebody else
    // signing in. Each of these either ends a session or starts a new one, and the new one is checked
    // where it is created.
    expect(admitsRefusedAccount(path)).toBe(true);
  });

  test.each([
    "/token",
    "/get-session",
    "/update-user",
    "/list-sessions",
    "/revoke-session",
    "/link-social",
    "/unlink-account",
    "/anything-a-plugin-adds",
  ])("%s — it acts as the account, so it is refused", (path) => {
    // Refused by default: an endpoint nobody listed is one a plugin may have added, and the safe answer
    // for an account that may not act is that it may not act there either.
    expect(admitsRefusedAccount(path)).toBe(false);
  });
});

describe("lifecycleRedirect — a refused magic link lands back on the adopter's screen", () => {
  const trusted = ["https://app.example.com"];

  test("to the errorCallbackURL the link carried, with the code", () => {
    const response = lifecycleRedirect(
      new URL(
        "https://api.example.com/auth/magic-link/verify?token=t&callbackURL=https%3A%2F%2Fapp.example.com%2Fcallback&errorCallbackURL=https%3A%2F%2Fapp.example.com%2Fsign-in",
      ),
      "https://api.example.com",
      trusted,
      suspended,
    );
    expect(response?.status).toBe(302);
    const location = new URL(response?.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe("https://app.example.com/sign-in");
    expect(location.searchParams.get("error")).toBe("auth/account_suspended");
  });

  test("to the callbackURL when no error target was named — Better Auth's own fallback", () => {
    const response = lifecycleRedirect(
      new URL(
        "https://api.example.com/auth/magic-link/verify?token=t&callbackURL=https%3A%2F%2Fapp.example.com%2Fcallback",
      ),
      "https://api.example.com",
      trusted,
      suspended,
    );
    const location = new URL(response?.headers.get("location") ?? "");
    expect(location.pathname).toBe("/callback");
    expect(location.searchParams.get("error")).toBe("auth/account_suspended");
  });

  test("never to an origin this Worker does not trust — that answers the refusal itself", () => {
    // Better Auth has already checked these URLs by the time a session is refused, so this is defense in
    // depth: an open redirect is not a thing a refusal gets to become.
    const response = lifecycleRedirect(
      new URL("https://api.example.com/auth/magic-link/verify?token=t&callbackURL=https%3A%2F%2Fevil.test%2F"),
      "https://api.example.com",
      trusted,
      suspended,
    );
    expect(response).toBeNull();
  });

  test("a relative target resolves against this Worker, which it trusts", () => {
    const response = lifecycleRedirect(
      new URL("https://api.example.com/auth/magic-link/verify?token=t&callbackURL=%2Fdone"),
      "https://api.example.com",
      trusted,
      suspended,
    );
    expect(response?.headers.get("location")).toBe("https://api.example.com/done?error=auth%2Faccount_suspended");
  });
});
