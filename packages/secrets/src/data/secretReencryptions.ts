// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The `pithy_secrets_reencryptions` table — one row per secret and per value sealed under it at rest,
 * saying which version of the secret that value was last re-encrypted under (#602).
 *
 * **It exists because the rotation and the re-encryption run in different Workers.** The secrets manager
 * rotates `auth-session-secret` and later retires its previous version; the JWKS private keys sealed under
 * that version live in the application's own database, which the manager never binds. So the Worker that
 * holds them re-encrypts them under the new version and records it here, in the secrets D1 both Workers
 * bind, and the manager's retirement reads this row before it removes anything.
 *
 * **A version key alone does not name a value.** `update` and `pithy secrets rotate` write a fresh
 * one-version envelope, so version `"2"` after either is a different value from the `"2"` before it. The row
 * therefore carries the version's fingerprint too — an HMAC of a fixed label keyed by the value, the
 * key-check value a key ceremony prints — and a row whose fingerprint is not the envelope's names nothing.
 *
 * No value, no ciphertext, and nothing a dependent's rows hold. The manager asks one question of this table
 * — *has every dependent moved?* — and the answer is a comparison of version keys and fingerprints.
 */
export const SecretReencryption = z
  .object({
    name: z.string().describe("The secret the value is sealed under, by registry name. Half the primary key."),
    dependent: z
      .string()
      .describe(
        "What is sealed under it, as its registry entry's `overlap.reencrypt` names it — `auth-jwks`. Half the primary key.",
      ),
    version: z.string().describe("The secret's version key this row is about."),
    fingerprint: z
      .string()
      .describe(
        "HMAC-SHA256 of a fixed label keyed by that version's value, in hex. Says which value the version key meant.",
      ),
    observedAt: SQLiteDate.describe(
      "When a dependent first saw this version as current. Re-encryption waits out every reader's cache from here.",
    ),
    movedAt: SQLiteDate.nullable().describe(
      "When every one of the dependent's values was re-encrypted under this version. Null while it is still waiting.",
    ),
  })
  .describe(
    "Which version of a secret one value sealed under it at rest was last re-encrypted under (`pithy_secrets_reencryptions`).",
  );
export type SecretReencryption = z.output<typeof SecretReencryption>;
