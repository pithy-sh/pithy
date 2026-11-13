// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { base64UrlEncode } from "@pithy-sh/core/src/controlPlane/token/base64url";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { AttestationChallenge } from "../data/attestationChallenge";
import type { AuthDatabase } from "../data/tables";

/** A challenge as the challenge route hands it out. */
export interface IssuedChallenge {
  challenge: string;
  expiresAt: Date;
}

/** What presenting a challenge established. */
export type ChallengeUse = { ok: true } | { ok: false; reason: string };

async function digest(challenge: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(challenge))));
}

/** Issue a challenge good for `expiresIn` seconds from `now`, pruning every one that has already run out. */
export async function issueChallenge(
  db: AuthDatabase,
  options: { now: Date; expiresIn: number },
): Promise<IssuedChallenge> {
  const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(options.now.getTime() + options.expiresIn * 1000);
  await db
    .deleteFrom("pithyAuthAttestationChallenges")
    .where("expiresAt", "<=", SQLiteDate.encode(options.now))
    .execute();
  await db
    .insertInto("pithyAuthAttestationChallenges")
    .values(AttestationChallenge.encode({ id: await digest(challenge), issuedAt: options.now, expiresAt }))
    .execute();
  return { challenge, expiresAt };
}

/**
 * Spend a challenge. One `DELETE … RETURNING`, so two requests racing on one challenge cannot both find it live:
 * the first takes the row and the second finds none. An expired challenge is spent and refused.
 */
export async function consumeChallenge(db: AuthDatabase, challenge: string, now: Date): Promise<ChallengeUse> {
  const row = await db
    .deleteFrom("pithyAuthAttestationChallenges")
    .where("id", "=", await digest(challenge))
    .returning(["id", "issuedAt", "expiresAt"])
    .executeTakeFirst();
  if (row === undefined) return { ok: false, reason: "the challenge was already used or never issued" };
  const { expiresAt } = AttestationChallenge.parse(row);
  if (expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: `the challenge expired at ${expiresAt.toISOString()}` };
  }
  return { ok: true };
}
