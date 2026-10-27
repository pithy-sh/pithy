// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WebhookUnverifiedError } from "../../error/pithyError";
import { type JwksCache, type OidcJwksFetch, verifyOidcToken } from "../../http/oidcWebhook";
import { ControlPlaneContext } from "../context";
import type { ControlPlaneConnection } from "../data/connection";
import { claimsMatch, findVerifyingTrust, observedClaims } from "../data/oidcTrust";
import {
  ControlPlaneInsufficientScopeError,
  ControlPlaneInvalidCredentialError,
  ControlPlaneNotConnectedError,
} from "../error/errors";
import { type ControlPlaneRequirement, ControlPlaneScope, scopeCovers } from "../scope/scope";

/**
 * Verify one call made under an OIDC trust (#722, `docs/AGENT-ACCESS.md` §6.2) — the second credential kind's
 * half of the decision `verify.ts` makes for a key.
 *
 * ## Per call, and the call still names its scope
 *
 * An identity token proves **who**, never **what**. So every call presents the workload's token on
 * `pithy-control-plane-oidc`, names the trust on `pithy-control-plane-trust`, and names the one scope it
 * exercises on `pithy-control-plane-scope`; the token is verified against the trust on every call, and the
 * scope is checked against the connection's grant exactly as a key's token is.
 *
 * **No exchange, deliberately.** Trading the token once for a short-lived credential would keep every
 * property of the key path, and it would put a key on the workload's host — the custody this credential kind
 * exists to remove. What remains is stated rather than hidden: a captured token replays against this one
 * audience until it expires, which is the provider's lifetime, minutes, and the same bound as revocation's
 * latency. There is no `jti` to spend, because one token serves every call in its job.
 *
 * ## The existing verifier, not a second one
 *
 * The token goes through `verifyOidcToken` from `core/src/http/oidcWebhook.ts`, with its ordering intact:
 * the algorithm pinned before a key is touched, the key resolved by `kid` from the issuer's published set,
 * the signature checked over the received segments, and only then a claim read. Its predicate is handed
 * `() => true` on purpose — the issuer, audience and freshness are still its to check, and the claims match
 * runs here, after, because a refusal here has to know **what** the token carried, which a boolean cannot say.
 *
 * ## One error, with one narrow exception
 *
 * Every failure raises {@link ControlPlaneInvalidCredentialError}, as on the key path, with the step in
 * `detail`. The exception is what it carries, never what it says: a claim mismatch on a token whose signature,
 * issuer and audience all verified records the claims it carried for the audit row. That is what makes a
 * custom issuer workable and a profiled one self-correcting. Before those three verify, nothing is recorded.
 */

/** What the trust path needs from the outside world. Every one is injectable, so every step is testable. */
export interface ControlPlaneTrustVerifyDeps {
  /**
   * This environment's connection, or null when none is registered. One per environment (`docs/CONTROL-PLANE.md`
   * §15), so a call names only the trust, and the connection is the one the Worker's own environment owns.
   */
  loadEnvironmentConnection: () => Promise<ControlPlaneConnection | null>;
  /** This Worker's environment name, checked against the connection's. */
  environment: string;
  /** The clock. */
  now: () => Date;
  /**
   * Where the issuers' key sets are held between calls. Built once per seam, never per request: an anonymous
   * caller naming a trust and an invented `kid` must cost a map lookup, not a round trip to the issuer.
   */
  jwksCache: JwksCache;
  /** The HTTP seam the issuers' key endpoints are reached through. Defaults to the runtime's `fetch`. */
  transport?: OidcJwksFetch;
  /**
   * Record the first allowed call under a trust, so a listing can stop saying *awaiting a first call*. Evidence
   * rather than part of the decision: it runs after the call is allowed, once, and a failure is swallowed.
   */
  recordFirstCall: (connectionId: string, trustId: string, at: Date) => Promise<void>;
}

/** One inbound call under a trust, reduced to what verification needs. */
export interface ControlPlaneTrustCall {
  /** The workload's OIDC token, from `pithy-control-plane-oidc`. */
  token: string | undefined;
  /** The trust the call names, from `pithy-control-plane-trust`. */
  trustId: string | undefined;
  /** The scope the call names, from `pithy-control-plane-scope`. */
  scope: string | undefined;
  /** What the route demands. */
  requirement: ControlPlaneRequirement;
}

/** Raise the one credential error, naming the failing step for the log and nobody else. */
function deny(step: string): never {
  throw new ControlPlaneInvalidCredentialError({ detail: step });
}

/** Verify one call under an OIDC trust, or throw. Returns the context the handler runs under. */
export async function verifyControlPlaneTrustCall(
  call: ControlPlaneTrustCall,
  deps: ControlPlaneTrustVerifyDeps,
): Promise<ControlPlaneContext> {
  // 1. Everything the call must name, before anything is loaded. A lookup an anonymous caller can buy with a
  //    header it did not finish writing is a lookup nobody needed.
  if (!call.token) deny("no OIDC token presented");
  if (!call.trustId) deny("an OIDC call named no trust");
  const scope = ControlPlaneScope.safeParse(call.scope);
  if (!scope.success) deny("an OIDC call named no well-formed scope");

  // 2. The environment's connection, and the trust it names. Lookups, not grants.
  const now = deps.now();
  const connection = await deps.loadEnvironmentConnection();
  if (!connection) {
    throw new ControlPlaneNotConnectedError({ detail: `no connection registered in environment ${deps.environment}` });
  }
  if (connection.environment !== deps.environment) {
    deny(`connection ${connection.id} is bound to ${connection.environment}, not ${deps.environment}`);
  }
  const trust = findVerifyingTrust(connection.trusts ?? [], call.trustId, now);
  if (!trust) deny(`trust ${call.trustId} is not a live trust on connection ${connection.id}`);

  // 3. The token, against the trust's issuer and audience, through the verifier the webhooks use. Its own
  //    errors for an unreachable key endpoint (502) and a misconfiguration (500) pass through: neither is the
  //    caller's, and both still refuse the call.
  let claims: Record<string, unknown>;
  try {
    claims = await verifyOidcToken(call.token, {
      issuers: [trust.issuer],
      jwksUrl: trust.jwksUrl,
      audience: trust.audience,
      claims: () => true,
      jwksCache: deps.jwksCache,
      ...(deps.transport === undefined ? {} : { transport: deps.transport }),
      now,
    });
  } catch (error) {
    if (error instanceof WebhookUnverifiedError)
      deny(`trust ${trust.trustId}: ${error.payload.detail ?? "unverified"}`);
    throw error;
  }

  // 4. The subject constraint — the boundary. Signature, issuer and audience have verified, so the claims the
  //    token carried are recorded on the refusal; the response is the same one every other step gives.
  if (!claimsMatch(trust.claims, claims)) {
    throw new ControlPlaneInvalidCredentialError({
      detail: `trust ${trust.trustId}: the token's claims do not match the trust's`,
      refusedTrust: { connectionId: connection.id, trustId: trust.trustId, observedClaims: observedClaims(claims) },
    });
  }

  // 5. Scope: what the call named, and what the adopter granted. The same check, and the same refusal, as a key's.
  const subject = typeof claims.sub === "string" && claims.sub !== "" ? claims.sub : `trust:${trust.trustId}`;
  if (!scopeCovers(call.requirement, scope.data, connection.scopes)) {
    throw new ControlPlaneInsufficientScopeError({
      detail: `required ${String(call.requirement)}; call named ${scope.data}; connection grants [${connection.scopes.join(", ")}]; trust ${trust.trustId}`,
      caller: {
        connectionId: connection.id,
        subject,
        keyId: trust.trustId,
        credentialKind: "trust",
        actorKind: connection.actorKind,
      },
    });
  }

  // 6. The first call this trust has answered, recorded once. Never part of the decision: the call is allowed.
  if (trust.firstCallAt === null) {
    await deps.recordFirstCall(connection.id, trust.trustId, now).catch(() => undefined);
  }

  return ControlPlaneContext.parse({
    connectionId: connection.id,
    environment: connection.environment,
    issuer: trust.issuer,
    subject,
    scope: scope.data,
    grantedScopes: connection.scopes,
    keyId: trust.trustId,
    tokenId: typeof claims.jti === "string" ? claims.jti : "",
    credentialKind: "trust",
    actorKind: connection.actorKind,
  });
}
