// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { SecretValueType } from "../registry";

/**
 * The `pithy_secrets_system_secrets` table — one encrypted row per stored secret in the
 * per-environment secrets D1. Ported from the CMS `system_secrets` model.
 *
 * The row carries an AES-256-GCM envelope (`encryptedValue` + `iv`) plus the `keyVersion`
 * that produced it, so the at-rest key-rotation job can re-encrypt under a new master key
 * without a consumer-visible change. The decrypted plaintext is a JSON version→value map
 * (`{ "1": <value> }`), so adding value-rotation later is append-a-version, not reshape.
 *
 * `z.output` is the app shape (a `Date` for the timestamps); `z.input` is the SQLite row
 * shape (ms-epoch numbers), via the `SQLiteDate` codec.
 */
export const SystemSecret = z
  .object({
    id: z
      .number()
      .int()
      .describe("Surrogate primary key, autoincremented by SQLite. Lookups use the unique `name` column."),
    name: z
      .string()
      .describe(
        "Stable identifier for the secret: a registry entry name, or `<keyspace>/<key>` for one member of a keyed entry; uniquely indexed.",
      ),
    encryptedValue: z.string().describe("Base64-encoded AES-256-GCM ciphertext of the version→value map."),
    iv: z.string().describe("Base64-encoded initialization vector; unique per encryption operation."),
    keyVersion: z
      .number()
      .int()
      .describe("Master-key version that produced this ciphertext; supports overlapping at-rest rotation windows."),
    valueType: SecretValueType.describe(
      "How the decrypted plaintext is interpreted once unwrapped from the version map: `text` or `json`.",
    ),
    createdAt: SQLiteDate.describe("When the secret was first written. Ms-epoch in SQLite, a `Date` in app code."),
    updatedAt: SQLiteDate.describe("When the secret was last written. Ms-epoch in SQLite, a `Date` in app code."),
  })
  .describe("One encrypted secret row in the per-environment secrets D1 (`pithy_secrets_system_secrets`).");
export type SystemSecret = z.output<typeof SystemSecret>;
