// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { OAUTH_SCOPES } from "../tokens/permissions";
import { missingScopes, SENSITIVE_SCOPES, SESSION_BASE_SCOPES, sensitiveScopesIn, sessionScopes } from "./scopes";

describe("sessionScopes", () => {
  test("is the base, then every scope the permissions need, de-duped in first-seen order", () => {
    expect(sessionScopes(["d1:write", "workers:write", "d1:write"])).toEqual([
      ...SESSION_BASE_SCOPES,
      "d1.write",
      "workers-scripts.write",
    ]);
  });

  test("a project composing nothing it does not use asks for nothing it does not use", () => {
    // The consent screen an adopter reads is the project's own surface. No vector capability, no
    // `vectorize.write`.
    expect(sessionScopes(["d1:write"])).not.toContain("vectorize.write");
  });

  test("the base names the person, renews without a browser, finds the account, and lets the session mint", () => {
    // `user-details.read` is what makes an audit row a person (`GET /user`); `offline_access` is the
    // only way Cloudflare issues a refresh token at all (measured); `account-settings.read` lists the
    // account on its own (measured); `account-api-tokens.write` is the mint.
    expect([...SESSION_BASE_SCOPES]).toEqual(
      expect.arrayContaining([
        "user-details.read",
        "offline_access",
        "account-api-tokens.write",
        "account-settings.read",
      ]),
    );
  });

  test("an unknown permission key is refused rather than silently asking for less", () => {
    expect(() => sessionScopes(["d1:destroy"])).toThrow(/d1:destroy/);
  });
});

describe("missingScopes", () => {
  test("names each requested scope the grant does not carry, in request order", () => {
    expect(missingScopes(["a.read", "b.write", "c.read"], "c.read a.read")).toEqual(["b.write"]);
  });

  test("a grant that carries everything, in any order and spacing, is missing nothing", () => {
    expect(missingScopes(["a.read", "b.write"], "  b.write   a.read ")).toEqual([]);
  });

  test("a scope granted beyond the request is not a problem it reports", () => {
    expect(missingScopes(["a.read"], "a.read z.write")).toEqual([]);
  });
});

describe("sensitive scopes", () => {
  test("names the sensitive scopes a request carries, by the words the consent screen uses", () => {
    expect(sensitiveScopesIn(["d1.write", "account-api-tokens.write"])).toEqual([
      { id: "account-api-tokens.write", name: "Account API Tokens Write" },
    ]);
  });

  test("a request carrying none has none to warn about", () => {
    expect(sensitiveScopesIn(["d1.write"])).toEqual([]);
  });

  test("every sensitive scope is one a session can actually be asked for", () => {
    // The list is ours to keep — the catalog does not mark sensitivity — so it must not drift into
    // naming a scope nothing requests.
    const requestable = new Set<string>([...SESSION_BASE_SCOPES, ...Object.values(OAUTH_SCOPES).flat()]);
    for (const id of Object.keys(SENSITIVE_SCOPES)) expect(requestable.has(id), id).toBe(true);
  });
});
