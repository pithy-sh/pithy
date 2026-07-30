// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ControlPlaneConfig } from "../config/config";
import {
  CONTROL_PLANE_CLOCK_SKEW_SECONDS,
  CONTROL_PLANE_JTI_TTL_SECONDS,
  CONTROL_PLANE_MAX_TOKEN_LIFETIME_SECONDS,
  ControlPlaneClaims,
  ControlPlaneJwsHeader,
} from "./claims";

const validClaims = {
  iss: "https://app.pithy.sh",
  aud: "0d1f4b6e-7c2a-4f52-9c1f-2b6a5d3e8a91",
  sub: "usr_7f3c",
  scope: "manifest:read",
  jti: "01JZ8Q2M4X0000000000000000",
  iat: 1_800_000_000,
  exp: 1_800_000_030,
  bodySha256: null,
};

describe("ControlPlaneClaims", () => {
  test("parses a well-formed payload", () => {
    expect(ControlPlaneClaims.parse(validClaims)).toEqual(validClaims);
  });

  test("accepts a body digest for a call that carries one", () => {
    const digest = "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0";
    expect(ControlPlaneClaims.parse({ ...validClaims, bodySha256: digest }).bodySha256).toBe(digest);
  });

  test("rejects an aud that is not a uuid — the connection id is the audience, not a name", () => {
    expect(ControlPlaneClaims.safeParse({ ...validClaims, aud: "the-dashboard" }).success).toBe(false);
    expect(ControlPlaneClaims.safeParse({ ...validClaims, aud: "" }).success).toBe(false);
  });

  test("rejects an iss that is not a url", () => {
    expect(ControlPlaneClaims.safeParse({ ...validClaims, iss: "app.pithy.sh" }).success).toBe(false);
  });

  test("rejects a malformed scope", () => {
    // One operation, colon-separated. A bare word names no action, and case is not part of the taxonomy.
    expect(ControlPlaneClaims.safeParse({ ...validClaims, scope: "manifest" }).success).toBe(false);
    expect(ControlPlaneClaims.safeParse({ ...validClaims, scope: "Manifest:Read" }).success).toBe(false);
    expect(ControlPlaneClaims.safeParse({ ...validClaims, scope: ["manifest:read"] }).success).toBe(false);
  });

  test("rejects a space-separated scope list — one token carries one scope", () => {
    expect(ControlPlaneClaims.safeParse({ ...validClaims, scope: "manifest:read keys:rotate" }).success).toBe(false);
  });

  test("rejects non-integer or fractional timestamps", () => {
    expect(ControlPlaneClaims.safeParse({ ...validClaims, iat: 1_800_000_000.5 }).success).toBe(false);
    expect(ControlPlaneClaims.safeParse({ ...validClaims, exp: "1800000030" }).success).toBe(false);
  });

  test("rejects a missing jti — replay defence needs an id to claim", () => {
    const { jti: _jti, ...withoutJti } = validClaims;
    expect(ControlPlaneClaims.safeParse(withoutJti).success).toBe(false);
    expect(ControlPlaneClaims.safeParse({ ...validClaims, jti: "" }).success).toBe(false);
    expect(ControlPlaneClaims.safeParse({ ...validClaims, jti: "j".repeat(129) }).success).toBe(false);
  });

  test("rejects a bodySha256 that is not a base64url sha-256", () => {
    expect(ControlPlaneClaims.safeParse({ ...validClaims, bodySha256: "not-a-digest" }).success).toBe(false);
    expect(ControlPlaneClaims.safeParse({ ...validClaims, bodySha256: "" }).success).toBe(false);
  });
});

describe("ControlPlaneJwsHeader", () => {
  const validHeader = { alg: "EdDSA", typ: "JWT", kid: "key_2026_07" };

  test("parses a well-formed header", () => {
    expect(ControlPlaneJwsHeader.parse(validHeader)).toEqual(validHeader);
  });

  test("rejects every alg but EdDSA — the algorithm-confusion defence", () => {
    // `none` and HMAC-verified-with-a-public-key are the two classic JWT breaks. A pinned literal makes
    // both unrepresentable: the header never selects the algorithm, the schema does.
    for (const alg of ["none", "None", "HS256", "RS256", "ES256", "EdDSA "]) {
      expect(ControlPlaneJwsHeader.safeParse({ ...validHeader, alg }).success).toBe(false);
    }
  });

  test("rejects a missing or oversized kid", () => {
    const { kid: _kid, ...withoutKid } = validHeader;
    expect(ControlPlaneJwsHeader.safeParse(withoutKid).success).toBe(false);
    expect(ControlPlaneJwsHeader.safeParse({ ...validHeader, kid: "" }).success).toBe(false);
    expect(ControlPlaneJwsHeader.safeParse({ ...validHeader, kid: "k".repeat(65) }).success).toBe(false);
  });

  test("rejects a typ that is not JWT", () => {
    expect(ControlPlaneJwsHeader.safeParse({ ...validHeader, typ: "JWS" }).success).toBe(false);
  });
});

describe("the token-lifetime constants", () => {
  test("hold the values the seam's replay window is built on", () => {
    expect(CONTROL_PLANE_MAX_TOKEN_LIFETIME_SECONDS).toBe(60);
    expect(CONTROL_PLANE_CLOCK_SKEW_SECONDS).toBe(60);
    expect(CONTROL_PLANE_JTI_TTL_SECONDS).toBe(300);
  });

  test("the jti TTL strictly outlives the longest window a token can be accepted in", () => {
    // This is the soundness relation, not a coincidence. A jti must stay in the replay set for as long
    // as the token bearing it could still verify — max lifetime plus skew at both ends. Drop the cap or
    // shrink the TTL below this and a token becomes replayable the moment its jti ages out.
    //
    // Strictly greater, not greater-or-equal. Equal means the memory ends on the same instant the token
    // stops being accepted, leaving the boundary to whichever clock rounds first — and `ControlPlaneConfig`
    // enforces the same strict inequality, so an equal pair would fail to parse anyway.
    expect(CONTROL_PLANE_JTI_TTL_SECONDS).toBeGreaterThan(
      CONTROL_PLANE_MAX_TOKEN_LIFETIME_SECONDS + 2 * CONTROL_PLANE_CLOCK_SKEW_SECONDS,
    );
  });

  test("the shipped defaults satisfy the config's own cross-field rule", () => {
    // The constants and the config must agree, or the defaults would fail to parse at assembly — the
    // failure mode where nothing works and the message points at a setting nobody touched.
    expect(() => ControlPlaneConfig.parse({})).not.toThrow();
    expect(ControlPlaneConfig.parse({}).jtiTtlSeconds).toBe(CONTROL_PLANE_JTI_TTL_SECONDS);
  });
});
