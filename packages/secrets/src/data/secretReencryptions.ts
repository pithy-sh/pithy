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
 * A version key and a timestamp, and nothing else. No value, no ciphertext, and nothing a dependent's
 * rows hold: the manager asks one question of this table — *has every dependent moved?* — and the answer
 * is a comparison of two version keys.
 */
export const SecretReencryption = z
  .object({
    name: z.string().describe("The secret the value is sealed under, by registry name. Half the primary key."),
    dependent: z
      .string()
      .describe(
        "What is sealed under it, as its registry entry's `overlap.reencrypt` names it — `auth-jwks`. Half the primary key.",
      ),
    version: z
      .string()
      .describe("The secret's version key every one of the dependent's values was last re-encrypted under."),
    recordedAt: SQLiteDate.describe("When that was recorded. Ms-epoch in SQLite, a `Date` in app code."),
  })
  .describe(
    "Which version of a secret one value sealed under it at rest was last re-encrypted under (`pithy_secrets_reencryptions`).",
  );
export type SecretReencryption = z.output<typeof SecretReencryption>;
