// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { defaultGithubUserInfo, githubIdentityFrom, resolveGithubEmail } from "./githubUserInfo";

/** A GitHub `/user/emails` page, in the shape the API actually returns. */
const emails = [
  { email: "personal@example.com", primary: true, verified: true },
  { email: "work@acme.dev", primary: false, verified: true },
];

describe("resolveGithubEmail", () => {
  test("takes the primary, and only the primary", () => {
    // The rule the issue settles: primary match links, nothing else does. GitHub never re-verifies, so a
    // verified secondary proves mailbox control *at some point* — a work address from a job somebody left
    // three years ago stays verified forever, and addresses get reassigned. Linking is a decision about
    // present control.
    expect(resolveGithubEmail(emails)).toEqual({ email: "personal@example.com", emailVerified: true });
  });

  test("carries GitHub's real verified flag, never a literal", () => {
    // Better Auth performs no independent check on what a resolver returns, so a hardcoded `true` here
    // would let an attacker who adds a victim's address to their own GitHub *unverified* match it.
    expect(resolveGithubEmail([{ email: "spoof@acme.dev", primary: true, verified: false }])).toEqual({
      email: "spoof@acme.dev",
      emailVerified: false,
    });
  });

  test("a page with no primary resolves nothing rather than guessing", () => {
    // Better Auth's own provider falls back to `emails[0]` when the profile carries no email. That is the
    // second way it silently picks a non-primary address, and it is not reproduced.
    expect(resolveGithubEmail([{ email: "work@acme.dev", primary: false, verified: true }])).toBeNull();
    expect(resolveGithubEmail([])).toBeNull();
  });
});

describe("githubIdentityFrom", () => {
  test("parses a well-formed pair", () => {
    const identity = githubIdentityFrom({ id: 42, login: "jo" }, emails);
    expect(identity?.profile.id).toBe(42);
    expect(identity?.emails).toHaveLength(2);
  });

  test("a profile with no id is a failure, not an identity", () => {
    // `accountSubject` reads `data.id`; an invalid subject collapses the callback into
    // `?error=unable_to_get_user_info`, which is a worse thing to debug than a refusal.
    expect(githubIdentityFrom({ login: "jo" }, emails)).toBeNull();
    expect(githubIdentityFrom({ id: null, login: "jo" }, emails)).toBeNull();
  });

  test("a non-array email payload is a failure rather than an empty list", () => {
    // Empty would read as "this account has no verified address", which is a sentence about the user.
    // GitHub answering with something else is a sentence about GitHub.
    expect(githubIdentityFrom({ id: 42 }, { message: "Bad credentials" })).toBeNull();
  });
});

describe("defaultGithubUserInfo", () => {
  /** A resolver over a canned fetch, so no case reaches the network. */
  function resolver(responses: Record<string, unknown>) {
    const fetchJson = vi.fn(async (url: string) => responses[url] ?? null);
    return defaultGithubUserInfo({ fetchJson: fetchJson as never });
  }

  const ok = {
    "https://api.github.com/user": { id: 7, login: "jo", name: "Jo" },
    "https://api.github.com/user/emails?per_page=100": emails,
  };

  test("a sign-in resolves the primary and reports GitHub's flag", async () => {
    const result = await resolver(ok)({ accessToken: "t" } as never);
    expect(result?.user.email).toBe("personal@example.com");
    expect(result?.user.emailVerified).toBe(true);
  });

  test("the display name and avatar travel too, because replacing getUserInfo replaces them", async () => {
    // Better Auth short-circuits its own GitHub resolver the moment `getUserInfo` exists, and writes
    // `name: userInfo.name || ""` into a notNull column. Returning only the email gave every GitHub
    // sign-up a blank name and no picture — on the sign-up path alone, which a link test never walks.
    const result = await resolver(ok)({ accessToken: "t" } as never);
    expect(result?.user.name).toBe("Jo");
    expect(result?.user.image).toBeUndefined();
  });

  test("the handle stands in when the profile carries no name, exactly as the stock resolver did", async () => {
    const result = await resolver({
      "https://api.github.com/user": { id: 7, login: "jo", avatar_url: "https://avatars.example/jo.png" },
      "https://api.github.com/user/emails?per_page=100": emails,
    })({ accessToken: "t" } as never);
    expect(result?.user.name).toBe("jo");
    expect(result?.user.image).toBe("https://avatars.example/jo.png");
  });

  test("the untouched profile travels as `data`, because accountSubject reads its id", async () => {
    const result = await resolver(ok)({ accessToken: "t" } as never);
    expect(result?.data).toEqual({ id: 7, login: "jo", name: "Jo" });
  });

  test("the address list never travels in `data` — /account-info serializes it to the client", async () => {
    const result = await resolver(ok)({ accessToken: "t" } as never);
    expect(JSON.stringify(result?.data)).not.toContain("work@acme.dev");
  });

  test("a fetch failure resolves nothing, distinguishably from an account with no addresses", async () => {
    // Fail closed. Collapsing the two would render a GitHub outage as `your account does not exist`.
    const result = await resolver({ "https://api.github.com/user": { id: 7 } })({ accessToken: "t" } as never);
    expect(result).toBeNull();
  });

  test("an unverified primary yields no email rather than an unverified match", async () => {
    const result = await resolver({
      "https://api.github.com/user": { id: 7 },
      "https://api.github.com/user/emails?per_page=100": [{ email: "spoof@acme.dev", primary: true, verified: false }],
    })({ accessToken: "t" } as never);
    expect(result?.user.email).toBeUndefined();
    expect(result?.user.emailVerified).toBe(false);
  });

  test("a verified primary is what a link is licensed by, on the link path as much as on sign-in", () => {
    // Linking is Better Auth's branch (`allowDifferentEmails` at callback.mjs:175), not this module's —
    // `getUserInfo` is handed only the tokens and cannot tell the two flows apart. What this module
    // contributes to the link path is the boundary: the only address it will ever hand back is one
    // GitHub reports verified, so a link licensed by an unconfirmed address is unreachable either way.
    expect(resolveGithubEmail([{ email: "spoof@acme.dev", primary: true, verified: false }])?.emailVerified).toBe(
      false,
    );
  });
});
