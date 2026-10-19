// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The session secret as Better Auth needs it across a rotation (#602): every retained version.**
 *
 * `auth-session-secret` is `rotatable: true`, and an unattended rotation appends a version and keeps the
 * previous one for the overlap. The kit used to hand Better Auth one value — the current one — which made
 * the overlap decorative: the moment the version changed, the JWKS private keys were sealed under a value
 * the instance no longer held. Better Auth 1.7 takes a version set instead (`secrets: [{ version, value }]`,
 * newest first): it encrypts under the first and decrypts under whichever version a ciphertext names
 * (`$ba$<version>$…`, `better-auth/dist/crypto/index.mjs`).
 *
 * **It versions encryption and not signatures.** With `secrets` set, `ctx.secret` is the first entry alone
 * (`context/create-context.mjs:75`), and the session cookie is signed and verified under `ctx.secret`
 * (`cookies/index.mjs:172`). So a cookie signed under the previous version still fails after a rotation;
 * `http/credentialResign.ts` is what verifies it under a retained version and re-signs it.
 *
 * **`secret` is the oldest retained version, and that is deliberate.** With a version set, Better Auth reads
 * `secret` only as the *legacy* secret — the one it tries on a bare ciphertext with no `$ba$` envelope. Every
 * JWKS key written before the kit passed a version set is one of those, sealed under the value that was
 * current then, which is the oldest the envelope still holds. Re-encryption moves them into the envelope;
 * until it has, this is what opens them.
 */

/** A secret's retained versions, as `secretsStore(…).getVersions` answers. */
export interface SessionSecretVersions {
  /** The version key reads resolve to. */
  currentVersion: string;
  /** Every retained version: version key → value. */
  versions: Readonly<Record<string, string>>;
}

/** What `betterAuth()` is handed: the version set, newest first, and the legacy secret. */
export interface BetterAuthSecretOptions {
  /** Every retained version, current first, then the rest newest first. */
  secrets: { version: number; value: string }[];
  /** The oldest retained version — Better Auth's legacy secret, for a ciphertext sealed before versions existed. */
  secret: string;
}

/** The retained versions, current first and the rest in descending numeric order. */
function ordered(versions: SessionSecretVersions): { version: number; value: string }[] {
  const prior = Object.entries(versions.versions)
    .filter(([version]) => version !== versions.currentVersion)
    .map(([version, value]) => ({ version: Number(version), value }))
    .sort((left, right) => right.version - left.version);
  const current = versions.versions[versions.currentVersion];
  return current === undefined ? prior : [{ version: Number(versions.currentVersion), value: current }, ...prior];
}

/** The version set and legacy secret for `betterAuth()`. */
export function betterAuthSecrets(versions: SessionSecretVersions): BetterAuthSecretOptions {
  const secrets = ordered(versions);
  const oldest = [...secrets].sort((left, right) => left.version - right.version)[0];
  return { secrets, secret: oldest?.value ?? "" };
}

/** Every retained value but the current one, newest first — what a credential signed before a rotation is tried under. */
export function priorSessionSecrets(versions: SessionSecretVersions): string[] {
  return ordered(versions)
    .filter((one) => String(one.version) !== versions.currentVersion)
    .map((one) => one.value);
}
