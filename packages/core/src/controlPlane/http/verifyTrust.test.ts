// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeAll, describe, expect, test } from "vitest";
import { UpstreamError } from "../../error/pithyError";
import { memoryJwksCache } from "../../http/oidcWebhook";
import { type MintedKey, mintKey, publishing, signToken } from "../../test-utils/oidcFixtures";
import type { ControlPlaneConnection } from "../data/connection";
import type { OidcTrust } from "../data/oidcTrust";
import {
  ControlPlaneInsufficientScopeError,
  ControlPlaneInvalidCredentialError,
  ControlPlaneNotConnectedError,
} from "../error/errors";
import { ANY_VERIFIED_CALLER, type ControlPlaneRequirement } from "../scope/scope";
import { type ControlPlaneTrustVerifyDeps, verifyControlPlaneTrustCall } from "./verifyTrust";

/**
 * The trust half of the control-plane decision, exercised with real RS256 keys and real signatures. Every
 * refusal below that is about claims is a token the issuer genuinely signed for this audience — the claims are
 * the boundary, and a test that refused a forgery would prove nothing about them.
 */

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const AUDIENCE = "https://api.example.com";
const NOW = new Date("2026-10-27T12:00:00.000Z");
const TRUST_ID = "4b8f0c1e-2a7d-4e0b-9c55-0f3a6d2e7b19";
const epoch = (at: Date) => Math.floor(at.getTime() / 1000);

let key: MintedKey;
let impostor: MintedKey;
beforeAll(async () => {
  key = await mintKey("gh-1");
  impostor = await mintKey("gh-1");
});

const trust: OidcTrust = {
  trustId: TRUST_ID,
  issuer: ISSUER,
  jwksUrl: JWKS_URL,
  audience: AUDIENCE,
  claims: { repository_id: "1262274726", environment: "leed-release" },
  authorizedBy: "ada@example.com",
  validFrom: new Date("2026-10-01T00:00:00.000Z"),
  revokedAt: null,
  firstCallAt: null,
};

function connection(overrides: Partial<ControlPlaneConnection> = {}): ControlPlaneConnection {
  return {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    environment: "prod",
    issuer: ISSUER,
    workerUrl: AUDIENCE,
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "agent",
    purpose: "Nightly audit summarizer.",
    scopes: ["manifest:read", "audit:events:read"],
    keys: [],
    trusts: [trust],
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "repo:acme/api:environment:leed-release",
    exp: epoch(NOW) + 300,
    iat: epoch(NOW) - 30,
    jti: "gh-jti-1",
    repository_id: "1262274726",
    environment: "leed-release",
    actor: "ada",
    ...overrides,
  };
}

interface Harness {
  deps: ControlPlaneTrustVerifyDeps;
  firstCalls: Array<{ connectionId: string; trustId: string; at: Date }>;
  fetched: string[];
}

function harness(registered: ControlPlaneConnection | null = connection()): Harness {
  const firstCalls: Harness["firstCalls"] = [];
  const fetched: string[] = [];
  return {
    firstCalls,
    fetched,
    deps: {
      loadEnvironmentConnection: async () => registered,
      environment: "prod",
      now: () => NOW,
      jwksCache: memoryJwksCache({ now: () => NOW }),
      transport: publishing(JWKS_URL, [key.jwk], fetched),
      recordFirstCall: async (connectionId, trustId, at) => {
        firstCalls.push({ connectionId, trustId, at });
      },
    },
  };
}

async function call(
  token: string | undefined,
  options: { trustId?: string; scope?: string; requirement?: ControlPlaneRequirement; h?: Harness } = {},
) {
  const h = options.h ?? harness();
  return verifyControlPlaneTrustCall(
    {
      token,
      trustId: "trustId" in options ? options.trustId : TRUST_ID,
      scope: "scope" in options ? options.scope : "audit:events:read",
      requirement: options.requirement ?? "audit:events:read",
    },
    h.deps,
  );
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("a call under a trust is allowed", () => {
  test("with a genuine token whose claims match, naming a granted scope", async () => {
    const context = await call(await signToken(claims(), key));
    expect(context).toMatchObject({
      connectionId: connection().id,
      environment: "prod",
      issuer: ISSUER,
      subject: "repo:acme/api:environment:leed-release",
      scope: "audit:events:read",
      keyId: TRUST_ID,
      tokenId: "gh-jti-1",
      credentialKind: "trust",
      actorKind: "agent",
    });
  });

  test("and records the trust's first call, once", async () => {
    const h = harness();
    await call(await signToken(claims(), key), { h });
    expect(h.firstCalls).toEqual([{ connectionId: connection().id, trustId: TRUST_ID, at: NOW }]);

    const called = harness(connection({ trusts: [{ ...trust, firstCallAt: NOW }] }));
    await call(await signToken(claims(), key), { h: called });
    expect(called.firstCalls).toEqual([]);
  });

  test("when recording the first call fails, because that is evidence and not the decision", async () => {
    const h = harness();
    h.deps.recordFirstCall = async () => {
      throw new Error("D1 unavailable");
    };
    await expect(call(await signToken(claims(), key), { h })).resolves.toBeDefined();
  });

  test("on a route any verified caller may use, whatever scope the call names", async () => {
    await expect(
      call(await signToken(claims(), key), { scope: "manifest:read", requirement: ANY_VERIFIED_CALLER }),
    ).resolves.toBeDefined();
  });

  test("again with the same token — verified per call, never spent", async () => {
    const h = harness();
    const token = await signToken(claims(), key);
    await call(token, { h });
    await expect(call(token, { h })).resolves.toBeDefined();
    // One key-set fetch for both calls: the cache is the seam's, not the call's.
    expect(h.fetched).toEqual([JWKS_URL]);
  });

  test("on a connection that holds a key as well — one object, two credential kinds", async () => {
    const both = connection({
      keys: [
        {
          keyId: "cpk_1",
          publicKey: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
          validFrom: new Date("2026-10-01T00:00:00.000Z"),
          validUntil: null,
          revokedAt: null,
        },
      ],
    });
    await expect(call(await signToken(claims(), key), { h: harness(both) })).resolves.toBeDefined();
  });
});

describe("a call under a trust is refused as an invalid credential", () => {
  test("with no token", async () => {
    expect(await refusal(call(undefined))).toBeInstanceOf(ControlPlaneInvalidCredentialError);
  });

  test("naming no trust", async () => {
    expect(await refusal(call(await signToken(claims(), key), { trustId: undefined }))).toBeInstanceOf(
      ControlPlaneInvalidCredentialError,
    );
  });

  test("naming no scope, because an identity token says who and never what", async () => {
    expect(await refusal(call(await signToken(claims(), key), { scope: undefined }))).toBeInstanceOf(
      ControlPlaneInvalidCredentialError,
    );
  });

  test("naming a malformed scope", async () => {
    expect(await refusal(call(await signToken(claims(), key), { scope: "ALL" }))).toBeInstanceOf(
      ControlPlaneInvalidCredentialError,
    );
  });

  test("naming a trust the connection does not hold, without fetching any key", async () => {
    const h = harness();
    expect(await refusal(call(await signToken(claims(), key), { trustId: "nope", h }))).toBeInstanceOf(
      ControlPlaneInvalidCredentialError,
    );
    expect(h.fetched).toEqual([]);
  });

  test("naming a revoked trust", async () => {
    const h = harness(connection({ trusts: [{ ...trust, revokedAt: NOW }] }));
    expect(await refusal(call(await signToken(claims(), key), { h }))).toBeInstanceOf(
      ControlPlaneInvalidCredentialError,
    );
  });

  test("with a valid token from an untrusted issuer", async () => {
    const error = await refusal(call(await signToken(claims({ iss: "https://gitlab.com" }), key)));
    expect(error).toBeInstanceOf(ControlPlaneInvalidCredentialError);
    // Not the claims: the issuer did not verify, so nothing about the token is recorded.
    expect((error as ControlPlaneInvalidCredentialError).refusedTrust).toBeNull();
  });

  test("with a valid token for another audience — the staging-to-production replay", async () => {
    const error = await refusal(call(await signToken(claims({ aud: "https://staging.example.com" }), key)));
    expect(error).toBeInstanceOf(ControlPlaneInvalidCredentialError);
    expect((error as ControlPlaneInvalidCredentialError).refusedTrust).toBeNull();
  });

  test("with a token signed by a key the issuer does not publish", async () => {
    const error = await refusal(call(await signToken(claims(), impostor)));
    expect(error).toBeInstanceOf(ControlPlaneInvalidCredentialError);
    expect((error as ControlPlaneInvalidCredentialError).refusedTrust).toBeNull();
  });

  test("with an expired token", async () => {
    expect(await refusal(call(await signToken(claims({ exp: epoch(NOW) - 3600 }), key)))).toBeInstanceOf(
      ControlPlaneInvalidCredentialError,
    );
  });

  test("with a valid token for an untrusted subject, recording the claims it carried", async () => {
    const error = await refusal(
      call(await signToken(claims({ repository_id: "999", environment: "leed-release" }), key)),
    );
    expect(error).toBeInstanceOf(ControlPlaneInvalidCredentialError);
    expect((error as ControlPlaneInvalidCredentialError).refusedTrust).toEqual({
      connectionId: connection().id,
      trustId: TRUST_ID,
      observedClaims: {
        sub: "repo:acme/api:environment:leed-release",
        repository_id: "999",
        environment: "leed-release",
        actor: "ada",
      },
    });
    // The caller's answer is the one every other step gives.
    expect((error as ControlPlaneInvalidCredentialError).payload.message).toBe("That credential is not valid here.");
  });
});

describe("a call under a trust is refused otherwise", () => {
  test("naming a scope the connection was not granted, like a key's", async () => {
    const error = await refusal(
      call(await signToken(claims(), key), {
        scope: "payments:entitlements:grant",
        requirement: "payments:entitlements:grant",
      }),
    );
    expect(error).toBeInstanceOf(ControlPlaneInsufficientScopeError);
    expect((error as ControlPlaneInsufficientScopeError).caller).toEqual({
      connectionId: connection().id,
      subject: "repo:acme/api:environment:leed-release",
      keyId: TRUST_ID,
      credentialKind: "trust",
      actorKind: "agent",
    });
  });

  test("naming one granted scope on a route that needs another", async () => {
    expect(
      await refusal(call(await signToken(claims(), key), { scope: "manifest:read", requirement: "audit:events:read" })),
    ).toBeInstanceOf(ControlPlaneInsufficientScopeError);
  });

  test("with nothing connected in this environment", async () => {
    expect(await refusal(call(await signToken(claims(), key), { h: harness(null) }))).toBeInstanceOf(
      ControlPlaneNotConnectedError,
    );
  });

  test("when the issuer's key endpoint cannot be read, as the issuer's failure", async () => {
    const h = harness();
    h.deps.transport = async () => ({ ok: false, status: 503, text: async () => "" });
    expect(await refusal(call(await signToken(claims(), key), { h }))).toBeInstanceOf(UpstreamError);
  });

  test("on a connection bound to another environment", async () => {
    expect(
      await refusal(call(await signToken(claims(), key), { h: harness(connection({ environment: "staging" })) })),
    ).toBeInstanceOf(ControlPlaneInvalidCredentialError);
  });
});
