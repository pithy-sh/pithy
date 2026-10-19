// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
import {
  claimReencryption,
  currentSealedVersion,
  recordReencryption,
  recordSoleVersion,
} from "@pithy-sh/secrets/src/rotation/reencryption";
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

/**
 * The versions this isolate has finished with — moved, or failed to — keyed by version and fingerprint, so a
 * version key reused after an `update` is a new version here too.
 */
const settled = new Set<string>();

/** The versions this isolate was told to wait on, with when to ask again. */
const waiting = new Map<string, number>();

/** Forget what this isolate has settled or is waiting on. For tests. */
export function resetJwksReencryption(): void {
  settled.clear();
  waiting.clear();
}

/** What {@link ensureJwksSealedUnderCurrent} needs. */
export interface EnsureJwksDeps {
  /** The application database the JWKS keys live in. */
  db: AuthDatabase;
  /**
   * That database's binding name — `auth({ database })`. The holder the move is recorded under, so two auth
   * Workers over two databases are waited for one by one rather than one answering for both.
   */
  holder: string;
  /** The secrets D1 the move is recorded in. */
  secrets: D1Database;
  /** The session secret's retained versions, as this request resolved them. */
  versions: SessionSecretVersions;
  /** Where a failure is said. Never fatal. */
  log: Logger;
  /** The clock. Defaults to now. */
  now?: Date;
}

/**
 * Make sure the JWKS keys are sealed under the current version, and that the secrets D1 says so — once per
 * version per isolate.
 *
 * **Recorded with one version too.** While the secret holds one version there is nothing to move, and the
 * record says the keys are under it ({@link recordSoleVersion}). That is how the manager knows this database
 * holds keys before the first rotation: a holder it has never heard from is one it cannot wait for.
 *
 * **Not on the first request that sees the version.** Another isolate may still hold the envelope it cached
 * before the append, with no key for the new version; a key re-sealed under it now would fail there. So the
 * first sight is recorded, and the move waits until every cache filled before it has expired
 * (`claimReencryption`, `REENCRYPTION_SETTLE_MS`). An isolate told to wait does not ask again until then.
 *
 * **Never fatal.** It runs on a request, and the request it rides on is somebody signing in; a failure here
 * leaves the keys where they were — still opening, since the previous version is still held — and the
 * retirement waiting. The next isolate tries again.
 */
export async function ensureJwksSealedUnderCurrent(deps: EnsureJwksDeps): Promise<void> {
  const { versions } = deps;
  const sole = Object.keys(versions.versions).length < 2;
  const now = deps.now ?? new Date();
  try {
    const sealed = await currentSealedVersion(versions);
    const key = `${deps.holder}:${sole ? "sole" : "rotating"}:${sealed.version}:${sealed.fingerprint}`;
    if (settled.has(key) || (waiting.get(key) ?? 0) > now.getTime()) return;
    try {
      const secretsDb = createDatabase(deps.secrets, secretsTables);
      const where = { name: AUTH_SESSION_SECRET, dependent: AUTH_JWKS_DEPENDENT, holder: deps.holder };
      if (sole) {
        settled.add(key);
        await recordSoleVersion(secretsDb, { ...where, sealed, now });
        return;
      }
      const claim = await claimReencryption(secretsDb, { ...where, sealed, now });
      if (claim.state === "moved") {
        settled.add(key);
        return;
      }
      if (claim.state === "settling") {
        waiting.set(key, claim.until.getTime());
        return;
      }
      settled.add(key);
      const moved = await reencryptJwks(deps.db, versions);
      await recordReencryption(secretsDb, { ...where, ...sealed, now });
      deps.log.info("jwks re-encrypted under the current session secret", { version: sealed.version, ...moved });
      if (moved.unopenable > 0) {
        deps.log.warn("jwks keys no retained session secret opens were left as they were", {
          unopenable: moved.unopenable,
        });
      }
    } catch (error) {
      // Settled for this isolate, so a failing database is not asked again on every request it serves.
      // Another isolate tries; until one finishes, retirement waits and the previous version keeps opening.
      settled.add(key);
      throw error;
    }
  } catch (error) {
    deps.log.warn("jwks re-encryption did not finish; the previous session secret stays until it does", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
