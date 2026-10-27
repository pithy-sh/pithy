// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { ControlPlaneKeyConflictError } from "../error/errors";
import {
  activeTrusts,
  appendTrust,
  claimsMatch,
  findVerifyingTrust,
  MAX_OBSERVED_CLAIMS,
  OidcClaimMatch,
  OidcTrust,
  observedClaims,
  RESERVED_OIDC_CLAIMS,
  revokeTrust,
  TRUST_REVOCATION_LATENCY,
} from "./oidcTrust";

const NOW = new Date("2026-10-27T12:00:00.000Z");

const trust: OidcTrust = {
  trustId: "4b8f0c1e-2a7d-4e0b-9c55-0f3a6d2e7b19",
  issuer: "https://token.actions.githubusercontent.com",
  jwksUrl: "https://token.actions.githubusercontent.com/.well-known/jwks",
  audience: "https://api.example.com",
  claims: { repository_id: "1262274726", environment: "leed-release" },
  authorizedBy: "ada@example.com",
  validFrom: new Date("2026-10-01T00:00:00.000Z"),
  revokedAt: null,
  firstCallAt: null,
};

describe("OidcClaimMatch — the subject constraint is the boundary", () => {
  it("refuses an empty matcher, because an issuer alone accepts every workload it serves", () => {
    const parsed = OidcClaimMatch.safeParse({});
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/every workload/);
  });

  it.each(RESERVED_OIDC_CLAIMS)("refuses %s, which names the token rather than the workload", (claim) => {
    expect(OidcClaimMatch.safeParse({ [claim]: "x" }).success).toBe(false);
  });

  it("refuses a matcher made only of reserved claims", () => {
    expect(OidcClaimMatch.safeParse({ aud: "https://api.example.com" }).success).toBe(false);
  });

  it("accepts `sub` as one claim among others, not a special case", () => {
    expect(OidcClaimMatch.safeParse({ sub: "repo:acme/api:environment:prod" }).success).toBe(true);
  });

  it("refuses a value carrying a control character, which a renderer would show as something else", () => {
    expect(OidcClaimMatch.safeParse({ ref: "refs/heads/main\n" }).success).toBe(false);
  });

  it("refuses an empty value, which no token carries and which would read as a wildcard", () => {
    expect(OidcClaimMatch.safeParse({ ref: "" }).success).toBe(false);
  });

  it("refuses a claim name outside the plain alphabet", () => {
    expect(OidcClaimMatch.safeParse({ "repo id": "1" }).success).toBe(false);
  });

  it("accepts a claim no profile has heard of, so a customized template still registers", () => {
    expect(OidcClaimMatch.safeParse({ "repo_custom:context": "acme/api:prod" }).success).toBe(true);
  });
});

describe("OidcTrust codec", () => {
  it("round-trips through JSON, as it does inside the trusts column", () => {
    const encoded = OidcTrust.encode(trust);
    expect(encoded.validFrom).toBe("2026-10-01T00:00:00.000Z");
    expect(OidcTrust.parse(JSON.parse(JSON.stringify(encoded)))).toEqual(trust);
  });

  it("refuses an issuer that is not https, since its keys are fetched from it", () => {
    expect(OidcTrust.safeParse({ ...OidcTrust.encode(trust), issuer: "http://issuer.example" }).success).toBe(false);
  });
});

describe("claimsMatch", () => {
  it("matches when every registered claim equals the token's", () => {
    expect(claimsMatch(trust.claims, { repository_id: "1262274726", environment: "leed-release", ref: "x" })).toBe(
      true,
    );
  });

  it("refuses when one registered claim differs", () => {
    expect(claimsMatch(trust.claims, { repository_id: "1262274726", environment: "staging" })).toBe(false);
  });

  it("refuses when a registered claim is absent", () => {
    expect(claimsMatch(trust.claims, { repository_id: "1262274726" })).toBe(false);
  });

  it("compares a numeric or boolean claim by its string form", () => {
    expect(claimsMatch({ project_id: "42", ref_protected: "true" }, { project_id: 42, ref_protected: true })).toBe(
      true,
    );
  });

  it("never matches an object or array claim, whatever its string form", () => {
    expect(claimsMatch({ groups: "admins" }, { groups: ["admins"] })).toBe(false);
  });

  it("refuses an empty matcher outright rather than vacuously matching", () => {
    expect(claimsMatch({}, { sub: "anything" })).toBe(false);
  });
});

describe("observedClaims", () => {
  it("keeps the workload's claims and drops the ones that name the token", () => {
    expect(
      observedClaims({ iss: "i", aud: "a", exp: 1, iat: 1, nbf: 1, jti: "j", repository_id: "7", ref_protected: true }),
    ).toEqual({ repository_id: "7", ref_protected: "true" });
  });

  it("drops a structured claim rather than flattening it", () => {
    expect(observedClaims({ groups: ["a"], sub: "s" })).toEqual({ sub: "s" });
  });

  it("caps what it records, so a token cannot fill the trail", () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`c${i}`, "v".repeat(1000)]));
    const recorded = observedClaims(many);
    expect(Object.keys(recorded)).toHaveLength(MAX_OBSERVED_CLAIMS);
    expect(Object.values(recorded).every((value) => value.length <= 256)).toBe(true);
  });
});

describe("the trust lifecycle", () => {
  it("finds a live trust by id", () => {
    expect(findVerifyingTrust([trust], trust.trustId, NOW)).toEqual(trust);
  });

  it("does not find a revoked trust", () => {
    expect(findVerifyingTrust([{ ...trust, revokedAt: NOW }], trust.trustId, NOW)).toBeNull();
  });

  it("does not find a trust before its validFrom", () => {
    expect(
      findVerifyingTrust([{ ...trust, validFrom: new Date(NOW.getTime() + 1000) }], trust.trustId, NOW),
    ).toBeNull();
  });

  it("does not find an id it does not hold", () => {
    expect(findVerifyingTrust([trust], "other", NOW)).toBeNull();
  });

  it("lists only live trusts", () => {
    const revoked = { ...trust, trustId: "gone", revokedAt: NOW };
    expect(activeTrusts([trust, revoked], NOW).map((t) => t.trustId)).toEqual([trust.trustId]);
  });

  it("appends a trust beside the others", () => {
    const next = { ...trust, trustId: "second" };
    expect(appendTrust([trust], next).map((t) => t.trustId)).toEqual([trust.trustId, "second"]);
  });

  it("refuses a duplicate trust id", () => {
    expect(() => appendTrust([trust], trust)).toThrow(ControlPlaneKeyConflictError);
  });

  it("revokes by id and keeps the row, so the listing can say when", () => {
    const revoked = revokeTrust([trust], trust.trustId, NOW);
    expect(revoked?.[0]?.revokedAt).toEqual(NOW);
  });

  it("keeps the first revocation's instant on a re-run", () => {
    const earlier = new Date(NOW.getTime() - 60_000);
    expect(revokeTrust([{ ...trust, revokedAt: earlier }], trust.trustId, NOW)?.[0]?.revokedAt).toEqual(earlier);
  });

  it("answers null for an id it does not hold", () => {
    expect(revokeTrust([trust], "other", NOW)).toBeNull();
  });
});

describe("TRUST_REVOCATION_LATENCY", () => {
  it("says that minted tokens stay live until they expire", () => {
    expect(TRUST_REVOCATION_LATENCY).toMatch(/already minted/);
    expect(TRUST_REVOCATION_LATENCY).toMatch(/expire/);
  });
});
