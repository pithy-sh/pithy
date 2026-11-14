// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import {
  AUTH_PLAY_INTEGRITY_SERVICE_ACCOUNT,
  type PlayIntegrityServiceAccount,
  resolvePlayIntegrityServiceAccount,
} from "../../instance/secrets";
import { AttestationConfigError } from "../errors";
import type { AttestationVerifier } from "../verifier";
import { createGoogleAccessTokens, decodeIntegrityToken, SERVICE_ACCOUNT_ACTION } from "./google";
import { judgeIntegrityVerdict } from "./verdict";

/** What a Play Integrity verifier is built from. Both default to the Worker's own. */
export interface PlayIntegrityVerifierOptions {
  /** How Google is called. */
  fetch?: typeof fetch;
  /** Where the service account is read from: auth's secret registry, by default. */
  serviceAccount?: (env: Readonly<Record<string, unknown>>) => Promise<PlayIntegrityServiceAccount>;
}

async function readServiceAccount(
  read: NonNullable<PlayIntegrityVerifierOptions["serviceAccount"]>,
  env: Readonly<Record<string, unknown>>,
): Promise<PlayIntegrityServiceAccount> {
  try {
    return await read(env);
  } catch (error) {
    throw new AttestationConfigError({
      detail: `the ${AUTH_PLAY_INTEGRITY_SERVICE_ACCOUNT} secret could not be read: ${error instanceof Error ? error.message : String(error)}`,
      action: SERVICE_ACCOUNT_ACTION,
    });
  }
}

/**
 * Google Play Integrity. Decodes the token through Google's `decodeIntegrityToken` with the environment's service
 * account, for each allowed package until one decodes, then judges the verdict against the request binding.
 *
 * The access token is held per service account for its lifetime, across requests this isolate serves. A Google
 * credential or setup fault is `auth/attestation_config`, and the token is dropped so the next request mints anew.
 */
export function createPlayIntegrityVerifier(options: PlayIntegrityVerifierOptions = {}): AttestationVerifier {
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const read =
    options.serviceAccount ?? ((env) => resolvePlayIntegrityServiceAccount(env as unknown as SecretsStoreEnv));
  const tokens = createGoogleAccessTokens(fetchImpl);
  return {
    async verify({ presented, binding, settings, env, now }) {
      if (settings.android.length === 0) {
        return { ok: false, reason: "requestPackageName: no Android app is allowed to attest here" };
      }
      const account = await readServiceAccount(read, env);
      const refusals: string[] = [];
      try {
        const accessToken = await tokens.get(account, now);
        for (const { packageName } of settings.android) {
          const decoded = await decodeIntegrityToken(fetchImpl, {
            accessToken,
            packageName,
            token: presented.assertion,
          });
          if (decoded.ok) return judgeIntegrityVerdict(decoded.payload, { binding, packageName, now });
          refusals.push(decoded.reason);
        }
      } catch (error) {
        if (error instanceof AttestationConfigError) tokens.drop(account);
        throw error;
      }
      return { ok: false, reason: `decode: ${refusals.join("; ")}` };
    },
  };
}

/** The Play Integrity verifier a Worker runs, calling Google with its own `fetch`. */
export const playIntegrityVerifier: AttestationVerifier = createPlayIntegrityVerifier();
