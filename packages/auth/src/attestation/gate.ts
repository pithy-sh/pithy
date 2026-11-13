// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workerIdentity } from "@pithy-sh/core/src/worker/identity";
import type { Context, MiddlewareHandler } from "hono";
import { authDatabase } from "../data/tables";
import { resolveDb } from "../http/resolve";
import { consumeChallenge } from "./challenge";
import { type AttestationConfig, type AttestationEnvironment, attestationFor } from "./config";
import { AttestationConfigError, AttestationFailedError, AttestationMissingError } from "./errors";
import { type AttestationVerifiers, isTestAssertion, verifierFor } from "./verifier";
import { ATTESTATION_HEADER, decodeAttestation, requestBinding } from "./wire";

/** What the send-route gate closes over. */
export interface SendGateOptions {
  /** Auth's resolved `attestation` block. */
  attestation: AttestationConfig;
  /** The D1 binding auth's tables live in. */
  database: string;
  /** The verifier for each platform's real assertions. */
  verifiers: AttestationVerifiers;
  /** The Turnstile guard a request with no attestation goes to, when turnstile is composed. */
  turnstile: MiddlewareHandler | undefined;
}

/** The refusal for an environment that has no block to judge an attestation by. */
function noBlock(environment: string | null): AttestationConfigError {
  const where = environment === null ? "an unstamped Worker" : `the ${environment} environment`;
  return new AttestationConfigError({
    detail: `${where} has no attestation block in auth's config`,
    action: `Add an \`attestation.environments.${environment ?? "<env>"}\` block to auth() in this Worker's pithy.config.ts, then redeploy.`,
  });
}

/** Judge one presented attestation. Returns when it verified; throws the refusal otherwise. */
async function verifyAttestation(
  c: Context,
  header: string,
  settings: AttestationEnvironment,
  environment: string | null,
  options: SendGateOptions,
): Promise<void> {
  const decoded = decodeAttestation(header);
  if (!decoded.ok) throw new AttestationFailedError({ detail: decoded.reason });
  const presented = decoded.value;
  const env = c.env as Record<string, unknown>;
  const db = authDatabase(resolveDb(env, options.database));
  const now = new Date();

  // Spent before anything else is judged, so a failed attempt cannot be retried on the same challenge.
  const use = await consumeChallenge(db, presented.challenge, now);
  if (!use.ok) throw new AttestationFailedError({ detail: use.reason });

  if (!isTestAssertion(presented) && settings[presented.platform].length === 0) {
    throw new AttestationFailedError({
      detail: `no ${presented.platform} app is allowed to attest in ${environment ?? "an unstamped Worker"}`,
    });
  }
  const verifier = verifierFor(presented, options.verifiers);
  if (verifier === undefined) {
    throw new AttestationConfigError({
      detail: `no ${presented.platform} attestation verifier is available to this Worker`,
      action: `Upgrade @pithy-sh/auth to a release that verifies ${presented.platform} attestations, or set this environment to test and send the test assertion.`,
    });
  }
  // The body is read off a clone: the route behind this gate is Better Auth's, and it reads the original.
  const body = new Uint8Array(await c.req.raw.clone().arrayBuffer());
  const binding = await requestBinding(presented.challenge, body);
  const verdict = await verifier.verify({ presented, binding, environment, settings, db, env, now });
  if (!verdict.ok) throw new AttestationFailedError({ detail: verdict.reason });
}

/**
 * The gate on auth's send routes once any environment has an attestation block.
 *
 * Either passes. A request carrying {@link ATTESTATION_HEADER} is judged by attestation alone, and a failure
 * there is final. A request without one goes to Turnstile when it is composed; with no Turnstile, it is refused
 * where this environment has a block, and passes where it has none, as it did before attestation existed.
 */
export function sendGate(options: SendGateOptions): MiddlewareHandler {
  return async (c, next) => {
    const environment = workerIdentity(c.env).environment;
    const settings = attestationFor(options.attestation, environment);
    const header = c.req.header(ATTESTATION_HEADER);
    if (header !== undefined) {
      if (settings === undefined) throw noBlock(environment);
      await verifyAttestation(c, header, settings, environment, options);
      return next();
    }
    if (options.turnstile !== undefined) return options.turnstile(c, next);
    if (settings !== undefined) {
      throw new AttestationMissingError({
        detail: `no ${ATTESTATION_HEADER} header, and turnstile is not composed to take the request instead`,
      });
    }
    return next();
  };
}

/** The challenge route's refusal where this environment has no block. Exported for the route. */
export function assertAttestationBlock(config: AttestationConfig, environment: string | null): AttestationEnvironment {
  const settings = attestationFor(config, environment);
  if (settings === undefined) throw noBlock(environment);
  return settings;
}
