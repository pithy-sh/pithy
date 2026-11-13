// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { base64UrlEncode } from "@pithy-sh/core/src/controlPlane/token/base64url";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { AppAttestKey } from "../../data/appAttestKey";
import type { AuthDatabase } from "../../data/tables";
import type { AttestedAppAttestKey } from "./attestation";

/** Store a key an attestation proved, at counter zero. Answers false when the key id is already registered. */
export async function storeAppAttestKey(db: AuthDatabase, key: AttestedAppAttestKey, now: Date): Promise<boolean> {
  const result = await db
    .insertInto("pithyAuthAppAttestKeys")
    .values(
      AppAttestKey.encode({
        id: base64UrlEncode(key.keyId),
        publicKey: base64UrlEncode(key.publicKey),
        appId: key.appId,
        environment: key.environment,
        counter: 0,
        createdAt: now,
        lastUsedAt: null,
      }),
    )
    .onConflict((conflict) => conflict.column("id").doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1;
}

/** The registered key with this id, or `undefined`. */
export async function findAppAttestKey(db: AuthDatabase, keyId: Uint8Array): Promise<AppAttestKey | undefined> {
  const row = await db
    .selectFrom("pithyAuthAppAttestKeys")
    .selectAll()
    .where("id", "=", base64UrlEncode(keyId))
    .executeTakeFirst();
  return row === undefined ? undefined : AppAttestKey.parse(row);
}

/**
 * Store an assertion's counter, only if it is still above the stored one. One conditional `UPDATE`, so two
 * requests racing on one counter cannot both move it: answers false for the one that lost.
 */
export async function advanceAppAttestCounter(
  db: AuthDatabase,
  keyId: Uint8Array,
  counter: number,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("pithyAuthAppAttestKeys")
    .set({ counter, lastUsedAt: SQLiteDate.encode(now) })
    .where("id", "=", base64UrlEncode(keyId))
    .where("counter", "<", counter)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}
