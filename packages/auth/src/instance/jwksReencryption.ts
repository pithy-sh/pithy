// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
import { pendingReencryptions, recordReencryption } from "@pithy-sh/secrets/src/rotation/reencryption";
import { parseEnvelope, type SecretConfig, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { AuthDatabase } from "../data/tables";
import { AUTH_JWKS_DEPENDENT, AUTH_SESSION_SECRET } from "./secrets";
import { betterAuthSecrets, type SessionSecretVersions } from "./sessionSecrets";

/**
 * **The JWKS private keys, moved under the session secret's newest version before the old one retires (#602).**
 *
 * Better Auth seals every key in `pithy_auth_jwks` under the session secret (`plugins/jwt/utils.mjs`), and a
 * key has no expiry that would make it safe to stop being able to open it. An unattended rotation of
 * `auth-session-secret` therefore waits, before it retires the previous version, for this Worker to say the
 * keys have moved — the secret's registry entry names them as `auth-jwks` — and this is where they move.
 *
 * Each key is opened under whichever retained version it names (`$ba$<version>$…`), or — for one sealed
 * before the kit handed Better Auth a version set, which carries no envelope — under each retained version
 * in turn, oldest first. It is sealed again under the current version and written back only if the row
 * still holds what was read, so two isolates moving the same key cannot interleave into a value neither
 * wrote. Then the move is recorded in the secrets D1, where the manager reads it.
 *
 * **It never makes a key unopenable.** A key no retained version opens is left exactly as it is and
 * counted; it was already lost, and nothing here can lose it further. It does not hold the record back,
 * because waiting cannot make it open — and a retirement held forever over a key that will never be used
 * is an envelope that grows on every rotation.
 */

/** What one pass did, in counts. */
export interface JwksReencryption {
  /** Keys sealed again under the current version. */
  moved: number;
  /** Keys already under it. */
  current: number;
  /** Keys no retained version opens. Left as they were. */
  unopenable: number;
}

/** Better Auth's own key structure for a version set, built the way `buildSecretConfig` builds it. */
function secretConfig(versions: SessionSecretVersions): SecretConfig {
  const { secrets } = betterAuthSecrets(versions);
  return {
    keys: new Map(secrets.map((one) => [one.version, one.value])),
    currentVersion: Number(versions.currentVersion),
  };
}

/** Open one stored private key, or `null` when no retained version opens it. */
async function opened(stored: string, versions: SessionSecretVersions, config: SecretConfig): Promise<string | null> {
  if (parseEnvelope(stored) !== null) {
    return await symmetricDecrypt({ key: config, data: stored }).catch(() => null);
  }
  // A bare ciphertext, from before the version set: sealed under whichever value was current then.
  const oldestFirst = [...betterAuthSecrets(versions).secrets].sort((left, right) => left.version - right.version);
  for (const candidate of oldestFirst) {
    const plain = await symmetricDecrypt({ key: candidate.value, data: stored }).catch(() => null);
    if (plain !== null) return plain;
  }
  return null;
}

/** Move every JWKS private key under the current version of the session secret. */
export async function reencryptJwks(db: AuthDatabase, versions: SessionSecretVersions): Promise<JwksReencryption> {
  const config = secretConfig(versions);
  const current = Number(versions.currentVersion);
  const result: JwksReencryption = { moved: 0, current: 0, unopenable: 0 };
  const rows = await db.selectFrom("pithyAuthJwks").select(["id", "privateKey"]).execute();
  for (const row of rows) {
    let stored: unknown;
    try {
      stored = JSON.parse(row.privateKey);
    } catch {
      stored = undefined;
    }
    if (typeof stored !== "string") {
      result.unopenable += 1;
      continue;
    }
    if (parseEnvelope(stored)?.version === current) {
      result.current += 1;
      continue;
    }
    const plain = await opened(stored, versions, config);
    if (plain === null) {
      result.unopenable += 1;
      continue;
    }
    const sealed = JSON.stringify(await symmetricEncrypt({ key: config, data: plain }));
    await db
      .updateTable("pithyAuthJwks")
      .set({ privateKey: sealed })
      .where("id", "=", row.id)
      .where("privateKey", "=", row.privateKey)
      .execute();
    result.moved += 1;
  }
  return result;
}

/** The versions this isolate has already moved the keys under — so one request per version pays for it. */
const settled = new Set<string>();

/** Forget what this isolate has settled. For tests. */
export function resetJwksReencryption(): void {
  settled.clear();
}

/** What {@link ensureJwksSealedUnderCurrent} needs. */
export interface EnsureJwksDeps {
  /** The application database the JWKS keys live in. */
  db: AuthDatabase;
  /** The secrets D1 the move is recorded in. */
  secrets: D1Database;
  /** The session secret's retained versions, as this request resolved them. */
  versions: SessionSecretVersions;
  /** Where a failure is said. Never fatal. */
  log: Logger;
}

/**
 * Make sure the JWKS keys are sealed under the current version, and that the secrets D1 says so — once per
 * version per isolate, and only while a previous version is retained.
 *
 * **Never fatal.** It runs on a request, and the request it rides on is somebody signing in; a failure here
 * leaves the keys where they were — still opening, since the previous version is still held — and the
 * retirement waiting. The next isolate tries again.
 */
export async function ensureJwksSealedUnderCurrent(deps: EnsureJwksDeps): Promise<void> {
  const { versions } = deps;
  if (Object.keys(versions.versions).length < 2 || settled.has(versions.currentVersion)) return;
  settled.add(versions.currentVersion);
  try {
    const secretsDb = createDatabase(deps.secrets, secretsTables);
    const pending = await pendingReencryptions(
      secretsDb,
      AUTH_SESSION_SECRET,
      [AUTH_JWKS_DEPENDENT],
      versions.currentVersion,
    );
    if (pending.length === 0) return;
    const moved = await reencryptJwks(deps.db, versions);
    await recordReencryption(secretsDb, {
      name: AUTH_SESSION_SECRET,
      dependent: AUTH_JWKS_DEPENDENT,
      version: versions.currentVersion,
    });
    deps.log.info("jwks re-encrypted under the current session secret", { version: versions.currentVersion, ...moved });
    if (moved.unopenable > 0) {
      deps.log.warn("jwks keys no retained session secret opens were left as they were", {
        unopenable: moved.unopenable,
      });
    }
  } catch (error) {
    // Left settled for this isolate, so a failing database is not asked again on every request it serves.
    // Another isolate tries; until one finishes, retirement waits and the previous version keeps opening.
    deps.log.warn("jwks re-encryption did not finish; the previous session secret stays until it does", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
