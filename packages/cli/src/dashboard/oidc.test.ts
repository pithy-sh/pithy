// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { OidcJwksFetch } from "@pithy-sh/core/src/http/oidcWebhook";
import { describe, expect, it } from "vitest";
import {
  defaultAudience,
  ISSUER_PROFILES,
  nameBasedNotes,
  parseIssuer,
  parseOidcClaims,
  profileFor,
  requireWorkloadIdentity,
  resolveIssuer,
} from "./oidc";

const GITHUB = "https://token.actions.githubusercontent.com";
const JWKS = `${GITHUB}/.well-known/jwks`;
const JWK = { kid: "k1", kty: "RSA", n: "AQAB", e: "AQAB" };

/** An issuer answering at every URL it is given, or failing where told to. */
function answering(pages: Record<string, unknown>, seen: string[] = []): OidcJwksFetch {
  return async (url) => {
    seen.push(url);
    if (!(url in pages)) return { ok: false, status: 404, text: async () => "" };
    const page = pages[url];
    return { ok: true, status: 200, text: async () => (typeof page === "string" ? page : JSON.stringify(page)) };
  };
}

describe("parseOidcClaims", () => {
  it("reads every name=value pair into one matcher", () => {
    expect(parseOidcClaims(["repository_id=1262274726", "environment=leed-release"])).toEqual({
      repository_id: "1262274726",
      environment: "leed-release",
    });
  });

  it("splits on the first =, so a value may carry one", () => {
    expect(parseOidcClaims(["sub=repo:acme/api:ref:refs/heads/a=b"])).toEqual({
      sub: "repo:acme/api:ref:refs/heads/a=b",
    });
  });

  it("refuses no claim at all, naming why", () => {
    expect(() => parseOidcClaims([])).toThrow(/every workload/);
  });

  it("refuses a pair with no =", () => {
    expect(() => parseOidcClaims(["repository_id"])).toThrow(/name=value/);
  });

  it("refuses a claim that names the token rather than the workload", () => {
    expect(() => parseOidcClaims(["aud=https://api.example.com"])).toThrow(/name the token/);
  });

  it("refuses one claim given two values", () => {
    expect(() => parseOidcClaims(["ref=a", "ref=b"])).toThrow(/twice/);
  });

  it("accepts one claim given the same value twice", () => {
    expect(parseOidcClaims(["ref=a", "ref=a"])).toEqual({ ref: "a" });
  });

  it("accepts a claim no profile names — a customized template registers cleanly", () => {
    expect(parseOidcClaims(["repo_custom_context=acme/api:prod"])).toEqual({ repo_custom_context: "acme/api:prod" });
  });
});

describe("profiles", () => {
  it("know GitHub and GitLab, recommending an immutable id first", () => {
    expect(profileFor(GITHUB)?.recommended[0]?.claim).toBe("repository_id");
    expect(profileFor("https://gitlab.com")?.recommended[0]?.claim).toBe("project_id");
  });

  it("know nothing about a custom issuer, which is an answer rather than a failure", () => {
    expect(profileFor("https://issuer.acme.example")).toBeUndefined();
  });

  it("are https issuers, every one", () => {
    for (const profile of ISSUER_PROFILES) expect(parseIssuer(profile.issuer)).toBe(profile.issuer);
  });
});

describe("requireWorkloadIdentity", () => {
  it.each([
    ["ref only", { ref: "refs/heads/main" }],
    ["environment only", { environment: "production" }],
    [
      "job-descriptive claims together",
      { ref_type: "branch", event_name: "push", runner_environment: "github-hosted" },
    ],
  ])("refuses a GitHub matcher on %s: anybody can make a repository that looks like that", (_, claims) => {
    expect(() => requireWorkloadIdentity(GITHUB, claims)).toThrow(/describe a job, not whose it is/);
  });

  it("names the immutable id as the claim to add", () => {
    expect(() => requireWorkloadIdentity(GITHUB, { environment: "production" })).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({ action: expect.stringMatching(/--oidc-claim repository_id=/) }),
      }),
    );
  });

  it("refuses a GitLab matcher on ref and ref_protected alone", () => {
    expect(() => requireWorkloadIdentity("https://gitlab.com", { ref: "main", ref_protected: "true" })).toThrow(
      /describe a job/,
    );
  });

  it.each([
    ["repository_id", { repository_id: "1", environment: "prod" }],
    ["repository_owner_id", { repository_owner_id: "9", ref: "refs/heads/main" }],
    ["sub", { sub: "repo:acme/api:environment:prod" }],
    ["job_workflow_ref", { job_workflow_ref: "acme/ci/.github/workflows/release.yml@refs/heads/main" }],
  ])("accepts a GitHub matcher naming the workload by %s", (_, claims) => {
    expect(requireWorkloadIdentity(GITHUB, claims)).toEqual(claims);
  });

  it("allows a claim no profile knows beside an identifying one", () => {
    const claims = { repository_id: "1", "repo_custom:ctx": "acme/api:prod" };
    expect(requireWorkloadIdentity(GITHUB, claims)).toEqual(claims);
  });

  it("holds a custom issuer to shape only", () => {
    expect(requireWorkloadIdentity("https://issuer.example.com", { ref: "main" })).toEqual({ ref: "main" });
  });

  it("still refuses an empty matcher first", () => {
    expect(() => requireWorkloadIdentity("https://issuer.example.com", {})).toThrow(/every workload it serves/);
  });

  it("every profile's first recommended claim identifies the workload", () => {
    for (const profile of ISSUER_PROFILES) expect(profile.identifying).toContain(profile.recommended[0]?.claim);
  });
});

describe("nameBasedNotes", () => {
  it("states the immutable-identifier trade for a name-based match", () => {
    expect(nameBasedNotes({ repository: "acme/api" })).toEqual([
      "repository is a name. repository_id survives a rename and cannot be claimed by a same-named project elsewhere; prefer it.",
    ]);
  });

  it("says nothing for an id", () => {
    expect(nameBasedNotes({ repository_id: "1", project_id: "2" })).toEqual([]);
  });
});

describe("parseIssuer", () => {
  it("refuses plain http, since its keys are fetched from it", () => {
    expect(() => parseIssuer("http://issuer.example")).toThrow(/https/);
  });

  it("refuses something that is not a URL", () => {
    expect(() => parseIssuer("github")).toThrow(/https/);
  });
});

describe("defaultAudience", () => {
  it("is the Worker's origin — a staging token then cannot name production", () => {
    expect(defaultAudience("https://api.example.com/some/path")).toBe("https://api.example.com");
  });
});

describe("resolveIssuer", () => {
  it("returns the key endpoint once discovery resolves and the key set parses", async () => {
    const seen: string[] = [];
    const jwksUrl = await resolveIssuer(
      GITHUB,
      answering(
        { [`${GITHUB}/.well-known/openid-configuration`]: { issuer: GITHUB, jwks_uri: JWKS }, [JWKS]: { keys: [JWK] } },
        seen,
      ),
    );
    expect(jwksUrl).toBe(JWKS);
    expect(seen).toEqual([`${GITHUB}/.well-known/openid-configuration`, JWKS]);
  });

  it("refuses an issuer whose discovery document is missing", async () => {
    await expect(resolveIssuer(GITHUB, answering({}))).rejects.toThrow(/does not resolve/);
  });

  it("refuses a discovery document describing another issuer", async () => {
    await expect(
      resolveIssuer(
        GITHUB,
        answering({
          [`${GITHUB}/.well-known/openid-configuration`]: { issuer: "https://evil.example", jwks_uri: JWKS },
        }),
      ),
    ).rejects.toThrow(/describes https:\/\/evil.example/);
  });

  it("refuses a key endpoint that publishes no key set", async () => {
    await expect(
      resolveIssuer(
        GITHUB,
        answering({
          [`${GITHUB}/.well-known/openid-configuration`]: { issuer: GITHUB, jwks_uri: JWKS },
          [JWKS]: { keys: [] },
        }),
      ),
    ).rejects.toThrow(/key set/);
  });

  it("refuses an answer that is not JSON", async () => {
    await expect(
      resolveIssuer(GITHUB, answering({ [`${GITHUB}/.well-known/openid-configuration`]: "<html>" })),
    ).rejects.toThrow(/not JSON/);
  });

  it("refuses an issuer that does not answer, as the issuer's failure", async () => {
    await expect(
      resolveIssuer(GITHUB, async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toMatchObject({ payload: { code: "core/upstream_failed" } });
  });
});
