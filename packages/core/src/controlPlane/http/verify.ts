// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneConfig } from "../config/config";
import { ControlPlaneContext } from "../context";
import type { ControlPlaneConnection } from "../data/connection";
import { findVerifyingKey } from "../data/keyLifecycle";
import {
  ControlPlaneInsufficientScopeError,
  ControlPlaneInvalidCredentialError,
  ControlPlaneNotConnectedError,
} from "../error/errors";
import type { ReplayGuard } from "../replay/guard";
import { type ControlPlaneRequirement, scopeCovers } from "../scope/scope";
import { sha256Base64Url, timingSafeEqual } from "../token/digest";
import { parseCompactJws, verifyEd25519 } from "../token/jws";

/**
 * The verification pipeline — the one place a control-plane call is decided.
 *
 * Written against a dependency object rather than a Hono context so the whole decision is testable
 * without a Worker: every step below is exercised in `verify.test.ts` with a fake connection loader and
 * a fake replay guard. The middleware in `guard.ts` is the thin part that reads those dependencies off
 * the request.
 *
 * ## The header is not `Authorization`, and that is deliberate
 *
 * `@pithy-sh/auth` installs a global middleware that, for **any** request carrying an `authorization`
 * header, builds a Better Auth instance and resolves a session against D1. A control-plane token on
 * that header would therefore hit the auth stack on every management call — wasted work at best, and
 * an unnecessary adjacency between two strategies that must stay separate. On {@link CONTROL_PLANE_HEADER}
 * the seam is invisible to it: no Better Auth instance is ever constructed for a control-plane call,
 * which is the structural fact behind "a control-plane call creates no user and no session".
 *
 * ## Order is a security property, not a style choice
 *
 * Nothing with a side effect happens before the signature verifies. In particular the `jti` is claimed
 * **last**: claim it earlier and an unauthenticated caller could burn the ids of tokens it merely
 * observed, denying a legitimate management client by replaying its own forgeries. Everything before
 * step 7 is a lookup or a comparison, and grants nothing on its own.
 *
 * ## One error for every failure, on purpose
 *
 * Every step but the scope check raises the same {@link ControlPlaneInvalidCredentialError}. A caller
 * cannot tell an unknown key from a bad signature from a replayed token, and so cannot use the response
 * to learn how far a forgery got. The step goes in `detail`, which the HTTP codec strips and the log
 * keeps. The scope failure is distinguished because by then the caller is proven legitimate — telling
 * them which grant they lack is actionable and leaks nothing they do not already hold.
 */

/**
 * The header names live in `../wire`, which imports nothing so that a browser can hold them — the far
 * end of this seam calls the adopter's Worker directly, and importing them from here drags WebCrypto
 * into a DOM-typed build.
 *
 * Re-exported because this path is already published: every caller outside the repo names
 * `@pithy-sh/core/src/controlPlane/http/verify`, and moving a wire constant must not break the
 * programs that speak the wire. Write new imports against `../wire`; everything in this repo already
 * does.
 */
export { CONTROL_PLANE_HEADER, CONTROL_PLANE_VERSION_HEADER } from "../wire";

/** What the pipeline needs from the outside world. Every one is injectable, so every step is testable. */
export interface ControlPlaneVerifyDeps {
  /** Load the connection a token addresses, by id. Null when no such connection exists here. */
  loadConnection: (connectionId: string) => Promise<ControlPlaneConnection | null>;
  /**
   * How many connections this environment has at all. Called **only** when the lookup above missed, to
   * separate "you have never connected anything" — worth saying plainly — from "that connection id is
   * not one of ours", which must stay indistinguishable from every other credential failure or it
   * becomes an oracle for enumerating connection ids.
   */
  countConnections: () => Promise<number>;
  /** The single-use gate over `jti`. */
  replay: ReplayGuard;
  /** This Worker's environment name, checked against the connection's. */
  environment: string;
  /** The resolved seam config — the token and window bounds this Worker enforces. */
  config: ControlPlaneConfig;
  /** The clock, injected so a test can stand at any instant. */
  now: () => Date;
}

/** One inbound call, reduced to what verification actually needs. */
export interface ControlPlaneCall {
  /** The compact JWS from {@link CONTROL_PLANE_HEADER}, or undefined when the caller sent none. */
  token: string | undefined;
  /** The raw request body bytes. Empty for a request that carries no body. */
  body: Uint8Array;
  /** What the route demands: one named scope, or merely a verified caller. */
  requirement: ControlPlaneRequirement;
}

/** Raise the one credential error, naming the failing step for the log and nobody else. */
function deny(step: string): never {
  throw new ControlPlaneInvalidCredentialError({ detail: step });
}

/**
 * Verify one control-plane call, or throw. Returns the context the handler runs under.
 *
 * The steps are numbered to match `docs/CONTROL-PLANE.md` §9.
 */
export async function verifyControlPlaneCall(
  call: ControlPlaneCall,
  deps: ControlPlaneVerifyDeps,
): Promise<ControlPlaneContext> {
  // 1. A credential was presented at all.
  if (!call.token) deny("no control-plane credential presented");

  // 2. Well-formed. Untrusted: a forged token parses exactly as cleanly as a genuine one.
  const { header, claims, signingInput, signature } = parseCompactJws(call.token);

  // 3. The connection the token addresses. A lookup, not a grant.
  const connection = await deps.loadConnection(claims.aud);
  if (!connection) {
    if ((await deps.countConnections()) === 0) {
      throw new ControlPlaneNotConnectedError({
        detail: `no connection registered in environment ${deps.environment}`,
      });
    }
    deny(`aud ${claims.aud} names no connection here`);
  }

  // 4. Environment. A staging credential must not reach production, and this is where that is true.
  if (connection.environment !== deps.environment) {
    deny(`connection ${connection.id} is bound to ${connection.environment}, not ${deps.environment}`);
  }

  // 5. Issuer. A validly-signed token minted by some other origin is still not for us.
  if (claims.iss !== connection.issuer) {
    deny(`iss ${claims.iss} is not the issuer connection ${connection.id} trusts`);
  }

  // 6. The key named by `kid`, if it is registered, unrevoked, and inside its window.
  const key = findVerifyingKey(connection.keys, header.kid, deps.now());
  if (!key) deny(`kid ${header.kid} is not a live key on connection ${connection.id}`);

  // 7. The signature. Authenticity is established here and nowhere earlier.
  if (!(await verifyEd25519(signingInput, signature, key.publicKey))) {
    deny(`signature does not verify under kid ${header.kid}`);
  }

  // 8. The lifetime this Worker is willing to honour, whatever the token asked for.
  const lifetime = claims.exp - claims.iat;
  if (lifetime <= 0 || lifetime > deps.config.maxTokenLifetimeSeconds) {
    deny(`token lifetime ${lifetime}s exceeds the ${deps.config.maxTokenLifetimeSeconds}s maximum`);
  }

  // 9. Expiry and issue time, within the configured skew.
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  const skew = deps.config.clockSkewSeconds;
  if (claims.exp <= nowSeconds - skew) deny(`token expired at ${claims.exp}, now ${nowSeconds}`);
  if (claims.iat > nowSeconds + skew) deny(`token issued at ${claims.iat} is in the future, now ${nowSeconds}`);

  // 10. The body digest. The signature covers the header and claims only, so without this a token could
  //     be lifted onto a different body for the same route.
  await verifyBodyDigest(call.body, claims.bodySha256);

  // 11. Scope. Both sides must agree: what the adopter granted, and what this one token was minted for.
  if (!scopeCovers(call.requirement, claims.scope, connection.scopes)) {
    throw new ControlPlaneInsufficientScopeError({
      detail: `required ${String(call.requirement)}; token carried ${claims.scope}; connection grants [${connection.scopes.join(", ")}]`,
    });
  }

  // 12. Spend the token. Last, because it is the only step that writes anything.
  if (!(await deps.replay.claim(claims.jti, connection.id))) {
    deny(`jti ${claims.jti} was already spent`);
  }

  return ControlPlaneContext.parse({
    connectionId: connection.id,
    environment: connection.environment,
    issuer: connection.issuer,
    subject: claims.sub,
    scope: claims.scope,
    grantedScopes: connection.scopes,
    keyId: key.keyId,
    tokenId: claims.jti,
  });
}

/**
 * The body digest check. `bodySha256` is null exactly when the body is empty — a bijection, so there is
 * no third state a caller could steer into. A token minted for an empty body cannot be presented with
 * one, and a token minted for a body cannot be presented without it.
 */
async function verifyBodyDigest(body: Uint8Array, claimed: string | null): Promise<void> {
  if (body.byteLength === 0) {
    if (claimed !== null) deny("token claims a body digest but the request carries no body");
    return;
  }
  if (claimed === null) deny("request carries a body but the token claims no digest");
  // Constant-time, though both values are already public: the habit is what keeps a future digest
  // comparison over something secret from being written the easy way.
  if (!timingSafeEqual(await sha256Base64Url(body), claimed)) deny("body digest does not match the token");
}
