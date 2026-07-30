// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeAll, describe, expect, test } from "vitest";
import { HttpError } from "../../error/http";
import { PithyError } from "../../error/pithyError";
import { ControlPlaneConfig } from "../config/config";
import type { ControlPlaneConnection, Ed25519PublicJwk, RegisteredKey } from "../data/connection";
import type { ReplayGuard } from "../kv/replay";
import { ANY_VERIFIED_CALLER, KEYS_ROTATE_SCOPE, MANIFEST_READ_SCOPE } from "../scope/scope";
import { base64UrlDecode, base64UrlEncode } from "../token/base64url";
import { exportPublicJwk, type MintControlPlaneToken, mintControlPlaneToken } from "../token/mint";
import { type ControlPlaneVerifyDeps, verifyControlPlaneCall } from "./verify";

/**
 * The verification pipeline, one failing step at a time.
 *
 * Real Ed25519 keys, real signatures, real tokens from `mintControlPlaneToken` — never a fixture. A
 * fixture would freeze the wire format into the test suite and prove nothing about the cryptography,
 * and the cryptography is the entire point of this file. Everything else is injected: the connection
 * loader, the replay guard, and the clock, so each case can stand at the exact instant it is about.
 *
 * Two properties matter more than any individual denial, and each has its own test below: **nothing
 * with a side effect happens before the signature verifies** (a forged token must not burn a `jti`),
 * and **no denial tells the caller which step failed** (the step lives in `detail`, which the HTTP
 * codec strips).
 */

const NOW = new Date("2026-03-01T00:00:00.000Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const DAY_SECONDS = 86_400;

const CONNECTION_ID = "0d1f4b6e-7c2a-4f52-9c1f-2b6a5d3e8a91";
const OTHER_CONNECTION_ID = "6b2e9a41-3f8d-4c17-b0a5-91d7e4c62f38";
const ISSUER = "https://app.pithy.sh";
const ENVIRONMENT = "production";
const KEY_ID = "key_2026_03";
const SUBJECT = "usr_7f3c";

let keyPair: CryptoKeyPair;
let publicJwk: Ed25519PublicJwk;
let attackerKeyPair: CryptoKeyPair;
let attackerPublicJwk: Ed25519PublicJwk;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  attackerKeyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicJwk = await exportPublicJwk(keyPair.publicKey);
  attackerPublicJwk = await exportPublicJwk(attackerKeyPair.publicKey);
});

/** One registered key, live since yesterday and open-ended unless a case says otherwise. */
function registeredKey(overrides: Partial<RegisteredKey> = {}): RegisteredKey {
  return {
    keyId: KEY_ID,
    publicKey: publicJwk,
    validFrom: at(-DAY_SECONDS),
    validUntil: null,
    revokedAt: null,
    ...overrides,
  };
}

/** The adopter's registration row, in the state a connected Worker actually holds. */
function connection(overrides: Partial<ControlPlaneConnection> = {}): ControlPlaneConnection {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: ISSUER,
    workerUrl: "https://api.example.com",
    scopes: [MANIFEST_READ_SCOPE],
    keys: [registeredKey()],
    createdAt: at(-DAY_SECONDS),
    updatedAt: at(-DAY_SECONDS),
    ...overrides,
  };
}

/** A replay guard that records every claim, so a test can assert what was spent — and what was not. */
function recordingReplayGuard(spent: readonly string[] = []) {
  const seen = new Set(spent);
  const calls: Array<{ jti: string; connectionId: string }> = [];
  const guard: ReplayGuard = {
    async claim(jti, connectionId) {
      calls.push({ jti, connectionId });
      if (seen.has(jti)) return false;
      seen.add(jti);
      return true;
    },
  };
  return { calls, guard };
}

interface DepsOptions {
  connection?: ControlPlaneConnection | null;
  /** How many connections exist at all. Defaults to "one if there is one", which is the connected state. */
  connectionCount?: number;
  environment?: string;
  now?: Date;
  replay?: ReplayGuard;
  config?: ControlPlaneConfig;
}

function makeDeps(options: DepsOptions = {}): ControlPlaneVerifyDeps {
  const registered = options.connection === undefined ? connection() : options.connection;
  return {
    loadConnection: async (id) => (registered && registered.id === id ? registered : null),
    countConnections: async () => options.connectionCount ?? (registered ? 1 : 0),
    replay: options.replay ?? recordingReplayGuard().guard,
    environment: options.environment ?? ENVIRONMENT,
    config: options.config ?? ControlPlaneConfig.parse({}),
    now: () => options.now ?? NOW,
  };
}

/** A genuine token for the standard connection, minted at {@link NOW} unless a case moves the clock. */
function mint(overrides: Partial<MintControlPlaneToken> = {}): Promise<string> {
  return mintControlPlaneToken({
    privateKey: keyPair.privateKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: SUBJECT,
    scope: MANIFEST_READ_SCOPE,
    now: () => NOW,
    ...overrides,
  });
}

const NO_BODY = new Uint8Array(0);

/** Run one call and hand back the `PithyError` it was denied with. Fails the test if it verified. */
async function denial(promise: Promise<unknown>): Promise<PithyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  return expect.fail("expected the call to be denied, but it verified");
}

describe("verifyControlPlaneCall — the happy path", () => {
  test("returns the verified caller, derived from the connection row and the token together", async () => {
    // Identity comes from the adopter's row (connectionId, environment, issuer, grantedScopes) and the
    // call comes from the token (subject, scope, jti). Neither side alone decides anything.
    const token = await mint({ tokenId: "jti_happy", scope: MANIFEST_READ_SCOPE });

    const context = await verifyControlPlaneCall(
      { token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
      makeDeps(),
    );

    expect(context).toEqual({
      connectionId: CONNECTION_ID,
      environment: ENVIRONMENT,
      issuer: ISSUER,
      subject: SUBJECT,
      scope: MANIFEST_READ_SCOPE,
      grantedScopes: [MANIFEST_READ_SCOPE],
      keyId: KEY_ID,
      tokenId: "jti_happy",
    });
  });
});

describe("verifyControlPlaneCall — presenting no credential", () => {
  test("denies a call with no token at all", async () => {
    // Defends the default: an unauthenticated request never reaches a handler, whatever route it hit.
    const error = await denial(
      verifyControlPlaneCall({ token: undefined, body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, makeDeps()),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
    expect(error.payload.status).toBe(401);
  });
});

describe("verifyControlPlaneCall — the connection lookup", () => {
  test("says plainly that nothing is connected when no connection is registered at all", async () => {
    // This is the SHIPPED DEFAULT of a Worker that composes the seam and has never been connected:
    // present, and denying everything. Saying so is safe because there is nothing to enumerate.
    const token = await mint();

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
        makeDeps({ connection: null, connectionCount: 0 }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/not_connected");
    expect(error.payload.status).toBe(403);
  });

  test("an unknown aud is a credential failure, not a not_connected, once any connection exists", async () => {
    // The enumeration-oracle defence. If "no such connection" answered differently from "bad
    // signature", a caller with no credential could walk uuids and learn which ones this Worker knows.
    const token = await mint({ connectionId: OTHER_CONNECTION_ID });

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
        makeDeps({ connectionCount: 3 }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
    expect(error.payload.status).toBe(401);
  });
});

describe("verifyControlPlaneCall — environment and issuer", () => {
  test("a staging credential cannot reach production", async () => {
    // The blast-radius boundary. A management client's staging key is handled loosely by definition —
    // it lives on laptops and in CI — and this is the check that keeps it from touching paying users.
    const token = await mint();

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
        makeDeps({ connection: connection({ environment: "staging" }), environment: "production" }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });

  test("denies a validly signed token minted by an issuer this connection does not trust", async () => {
    // The signature only proves the key. It says nothing about which origin minted the token, so a
    // management client whose key was registered elsewhere still cannot address this connection.
    const token = await mint({ issuer: "https://evil.example.com" });

    const error = await denial(
      verifyControlPlaneCall({ token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, makeDeps()),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });
});

describe("verifyControlPlaneCall — key selection", () => {
  test("denies a kid nobody registered, rather than falling back to another live key", async () => {
    // Matching a token to "some key that works" would make the `kid` decorative and revocation
    // meaningless. The named key verifies the call, or nothing does.
    const token = await mint({ keyId: "key_the_attacker_named" });

    const error = await denial(
      verifyControlPlaneCall({ token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, makeDeps()),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });

  test("denies a revoked key immediately, ignoring its still-open window", async () => {
    // Revocation is the adopter's unilateral control over a compromised management client. It has to
    // bite the moment it is written, not when a window happens to close.
    const token = await mint();

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
        makeDeps({ connection: connection({ keys: [registeredKey({ revokedAt: at(-60) })] }) }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });

  test("denies a key whose validity window has already closed", async () => {
    // The superseded half of a completed rotation. The row keeps it for the audit trail; verification
    // must not keep honouring it.
    const token = await mint();

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
        makeDeps({ connection: connection({ keys: [registeredKey({ validUntil: at(-60) })] }) }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });

  test("denies a key registered ahead of its validFrom, so a key cannot be used early", async () => {
    // A key staged for a future rotation is not a live key. Honouring it early would let a client
    // pre-register a credential and start using it before the adopter expected it to exist.
    const token = await mint();

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
        makeDeps({ connection: connection({ keys: [registeredKey({ validFrom: at(DAY_SECONDS) })] }) }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });
});

describe("verifyControlPlaneCall — the signature", () => {
  test("denies a token signed by a keypair other than the registered one", async () => {
    // The forgery case. Everything else about this token is right — aud, iss, kid, scope, window — and
    // the only thing wrong with it is the one thing that matters.
    const token = await mint({ privateKey: attackerKeyPair.privateKey });

    const error = await denial(
      verifyControlPlaneCall({ token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, makeDeps()),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
    // And the attacker's own key is a perfectly good key — it is simply not this connection's.
    expect(attackerPublicJwk.x).not.toBe(publicJwk.x);
  });

  test("denies a re-encoded payload that escalates scope while keeping the original signature", async () => {
    // Tampering. The connection grants both scopes and the route requires the escalated one, so if this
    // were admitted it would succeed — the denial has to come from the signature, not from the scope.
    const token = await mint({ scope: MANIFEST_READ_SCOPE });
    const [header, claims, signature] = token.split(".") as [string, string, string];
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(claims))) as Record<string, unknown>;
    const escalated = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ ...decoded, scope: KEYS_ROTATE_SCOPE })),
    );

    const error = await denial(
      verifyControlPlaneCall(
        { token: `${header}.${escalated}.${signature}`, body: NO_BODY, requirement: KEYS_ROTATE_SCOPE },
        makeDeps({ connection: connection({ scopes: [MANIFEST_READ_SCOPE, KEYS_ROTATE_SCOPE] }) }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
    expect(error.payload.status).toBe(401);
  });
});

describe("verifyControlPlaneCall — the time window", () => {
  test("denies a token past its expiry by more than the skew", async () => {
    // A captured token stops being useful. Without this it never would.
    const token = await mint();

    const error = await denial(
      verifyControlPlaneCall({ token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, makeDeps({ now: at(120) })),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });

  test("admits a token one second inside the skew, so a drifting clock does not lock a client out", async () => {
    // The other half of the same setting. Skew exists because two machines disagree, and a management
    // client refused for that reason has no way to notice, let alone fix it.
    const token = await mint({ tokenId: "jti_edge" });

    const context = await verifyControlPlaneCall(
      { token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
      makeDeps({ now: at(119) }),
    );

    expect(context.tokenId).toBe("jti_edge");
  });

  test("denies a token issued further in the future than the skew allows", async () => {
    // A client whose clock runs fast is drift; a client that mints ahead deliberately is buying itself
    // a longer window than the adopter agreed to. Both are refused by the same bound.
    const token = await mint({ now: () => at(61) });

    const error = await denial(
      verifyControlPlaneCall({ token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, makeDeps()),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });

  test("denies a lifetime longer than this Worker honours, even while the token is unexpired", async () => {
    // This is what makes the replay TTL sound. The jti is remembered for a fixed span; a token allowed
    // to outlive that memory would replay cleanly for the remainder of its life. The cap is enforced
    // here rather than trusted to the client, which is why the token below is refused while still valid.
    const token = await mint({ lifetimeSeconds: 300 });
    const deps = makeDeps();

    const error = await denial(
      verifyControlPlaneCall({ token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, deps),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
    expect(deps.config.maxTokenLifetimeSeconds).toBe(60);
  });
});

describe("verifyControlPlaneCall — body binding", () => {
  const body = (json: unknown) => new TextEncoder().encode(JSON.stringify(json));

  test("admits a body whose digest is the one the token committed to", async () => {
    const payload = body({ keyId: "key_2026_04" });
    const token = await mint({ scope: KEYS_ROTATE_SCOPE, body: payload, tokenId: "jti_body" });

    const context = await verifyControlPlaneCall(
      { token, body: payload, requirement: KEYS_ROTATE_SCOPE },
      makeDeps({ connection: connection({ scopes: [KEYS_ROTATE_SCOPE] }) }),
    );

    expect(context.tokenId).toBe("jti_body");
  });

  test("denies a token lifted onto a different body for the same route", async () => {
    // The signature covers the header and claims only. Without the digest, an intercepted keys:rotate
    // token would authorize *any* keys:rotate body — including one registering the interceptor's key.
    const token = await mint({ scope: KEYS_ROTATE_SCOPE, body: body({ keyId: "key_2026_04" }) });

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: body({ keyId: "key_the_attacker_owns" }), requirement: KEYS_ROTATE_SCOPE },
        makeDeps({ connection: connection({ scopes: [KEYS_ROTATE_SCOPE] }) }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });

  test("denies a token claiming a digest when the request carries no body", async () => {
    // Half of the bijection: null digest ⇔ empty body. Stripping the body must not be a way to skip the
    // check that binds the token to it.
    const token = await mint({ scope: KEYS_ROTATE_SCOPE, body: body({ keyId: "key_2026_04" }) });

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: KEYS_ROTATE_SCOPE },
        makeDeps({ connection: connection({ scopes: [KEYS_ROTATE_SCOPE] }) }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });

  test("denies a body presented under a token minted with no digest", async () => {
    // The other half. A bodyless token — a ping's, say — must not be stapled onto a write.
    const token = await mint({ scope: KEYS_ROTATE_SCOPE });

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: body({ keyId: "key_the_attacker_owns" }), requirement: KEYS_ROTATE_SCOPE },
        makeDeps({ connection: connection({ scopes: [KEYS_ROTATE_SCOPE] }) }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
  });
});

describe("verifyControlPlaneCall — scope", () => {
  test("a scope the connection was never granted is the one deliberately distinguishable failure", async () => {
    // 403 and its own code, not the blanket 401. By this point the caller is proven legitimate, so
    // telling them which grant they lack is actionable and leaks nothing they do not already hold.
    const token = await mint({ scope: KEYS_ROTATE_SCOPE });

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: KEYS_ROTATE_SCOPE },
        makeDeps({ connection: connection({ scopes: [MANIFEST_READ_SCOPE] }) }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/insufficient_scope");
    expect(error.payload.status).toBe(403);
  });

  test("a token minted for another operation is refused however broad the grant is", async () => {
    // One token, one call, one operation. A connection granted everything still spends a manifest:read
    // token on manifest:read and nothing else.
    const token = await mint({ scope: MANIFEST_READ_SCOPE });

    const error = await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: KEYS_ROTATE_SCOPE },
        makeDeps({ connection: connection({ scopes: [MANIFEST_READ_SCOPE, KEYS_ROTATE_SCOPE] }) }),
      ),
    );

    expect(error.payload.code).toBe("controlplane/insufficient_scope");
  });

  test("ANY_VERIFIED_CALLER admits a connection granted nothing at all", async () => {
    // Ping is how a newly registered key is proven before the key it replaces is expired, and that
    // ordering is the whole safety property of rotation. A ping that could be withheld would let a
    // connection reach a state where the replacement can never be proven.
    const token = await mint({ tokenId: "jti_ping" });

    const context = await verifyControlPlaneCall(
      { token, body: NO_BODY, requirement: ANY_VERIFIED_CALLER },
      makeDeps({ connection: connection({ scopes: [] }) }),
    );

    expect(context.grantedScopes).toEqual([]);
    expect(context.tokenId).toBe("jti_ping");
  });
});

describe("verifyControlPlaneCall — replay", () => {
  test("spends the jti on the connection, and refuses the same token a second time", async () => {
    // Every other check asks what the call *is*; none of them notices the same valid call arriving
    // twice. This is what notices.
    const token = await mint({ tokenId: "jti_once" });
    const replay = recordingReplayGuard();
    const deps = makeDeps({ replay: replay.guard });

    await verifyControlPlaneCall({ token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, deps);
    const error = await denial(
      verifyControlPlaneCall({ token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, deps),
    );

    expect(error.payload.code).toBe("controlplane/invalid_credential");
    expect(replay.calls).toEqual([
      { jti: "jti_once", connectionId: CONNECTION_ID },
      { jti: "jti_once", connectionId: CONNECTION_ID },
    ]);
  });
});

describe("verifyControlPlaneCall — ordering", () => {
  test("a bad signature never claims the jti it carried", async () => {
    // The most important ordering property in the seam. Claim before verifying and an unauthenticated
    // caller could burn the jtis of tokens it merely observed — replaying its own forgeries to lock a
    // legitimate management client out of every call it was about to make. So nothing is spent until
    // authenticity is established.
    const token = await mint({ privateKey: attackerKeyPair.privateKey, tokenId: "jti_forged" });
    const replay = recordingReplayGuard();

    await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
        makeDeps({ replay: replay.guard }),
      ),
    );

    expect(replay.calls).toEqual([]);
  });

  test("a scope failure never claims the jti either", async () => {
    // Same property, from the other side: a legitimate client asking for something it was not granted
    // gets a 403 and keeps its token id. Otherwise one mis-scoped retry loop would poison the set.
    const token = await mint({ scope: KEYS_ROTATE_SCOPE, tokenId: "jti_unscoped" });
    const replay = recordingReplayGuard();

    await denial(
      verifyControlPlaneCall(
        { token, body: NO_BODY, requirement: KEYS_ROTATE_SCOPE },
        makeDeps({ connection: connection({ scopes: [MANIFEST_READ_SCOPE] }), replay: replay.guard }),
      ),
    );

    expect(replay.calls).toEqual([]);
  });
});

describe("verifyControlPlaneCall — what a denial tells the caller", () => {
  test("every credential failure is one indistinguishable error, and the wire carries no detail", async () => {
    // The oracle defence, asserted across the whole pipeline at once. A caller sees the same code, the
    // same status, and the same words whether their key was unknown, their signature forged, their
    // token stale or their body swapped — so the response cannot be used to learn how far a forgery
    // got. The step that actually failed goes in `detail`, which the HTTP codec strips (error/http.ts).
    const goodToken = await mint({ tokenId: "jti_replayed" });
    const spentReplay = recordingReplayGuard(["jti_replayed"]);

    // Thunks, not promises. Building all eleven up front would leave ten of them rejected and
    // unawaited while the first is inspected, which vitest reports as an unhandled rejection.
    const denials: Array<[string, () => Promise<unknown>]> = [
      [
        "no credential",
        () => verifyControlPlaneCall({ token: undefined, body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, makeDeps()),
      ],
      [
        "malformed token",
        () =>
          verifyControlPlaneCall({ token: "not.a.jws", body: NO_BODY, requirement: MANIFEST_READ_SCOPE }, makeDeps()),
      ],
      [
        "unknown aud",
        async () =>
          verifyControlPlaneCall(
            {
              token: await mint({ connectionId: OTHER_CONNECTION_ID }),
              body: NO_BODY,
              requirement: MANIFEST_READ_SCOPE,
            },
            makeDeps({ connectionCount: 3 }),
          ),
      ],
      [
        "wrong environment",
        () =>
          verifyControlPlaneCall(
            { token: goodToken, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
            makeDeps({ connection: connection({ environment: "staging" }) }),
          ),
      ],
      [
        "untrusted issuer",
        async () =>
          verifyControlPlaneCall(
            {
              token: await mint({ issuer: "https://evil.example.com" }),
              body: NO_BODY,
              requirement: MANIFEST_READ_SCOPE,
            },
            makeDeps(),
          ),
      ],
      [
        "unknown kid",
        async () =>
          verifyControlPlaneCall(
            { token: await mint({ keyId: "key_the_attacker_named" }), body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
            makeDeps(),
          ),
      ],
      [
        "forged signature",
        async () =>
          verifyControlPlaneCall(
            {
              token: await mint({ privateKey: attackerKeyPair.privateKey }),
              body: NO_BODY,
              requirement: MANIFEST_READ_SCOPE,
            },
            makeDeps(),
          ),
      ],
      [
        "expired token",
        () =>
          verifyControlPlaneCall(
            { token: goodToken, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
            makeDeps({ now: at(300) }),
          ),
      ],
      [
        "oversized lifetime",
        async () =>
          verifyControlPlaneCall(
            { token: await mint({ lifetimeSeconds: 300 }), body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
            makeDeps(),
          ),
      ],
      [
        "swapped body",
        async () =>
          verifyControlPlaneCall(
            {
              token: await mint({ body: new TextEncoder().encode("{}") }),
              body: new TextEncoder().encode('{"stolen":true}'),
              requirement: MANIFEST_READ_SCOPE,
            },
            makeDeps(),
          ),
      ],
      [
        "replayed token",
        () =>
          verifyControlPlaneCall(
            { token: goodToken, body: NO_BODY, requirement: MANIFEST_READ_SCOPE },
            makeDeps({ replay: spentReplay.guard }),
          ),
      ],
    ];

    const seen = new Set<string>();
    for (const [label, call] of denials) {
      const error = await denial(call());
      expect(error.payload.code, label).toBe("controlplane/invalid_credential");
      expect(error.payload.status, label).toBe(401);
      // The throw site named the step for the log...
      expect(error.payload.detail, label).toBeTypeOf("string");
      // ...and the wire never sees it.
      const wire = HttpError.encode(error.payload);
      expect(wire, label).not.toHaveProperty("detail");
      expect(JSON.stringify(wire), label).not.toContain("signature");
      seen.add(`${error.payload.message}|${error.payload.action}`);
    }

    // One public wording for all eleven, so the words themselves cannot be compared either.
    expect(seen.size).toBe(1);
  });
});
