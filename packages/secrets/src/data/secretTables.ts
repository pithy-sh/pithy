// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The `pithy_secrets_tables` table — one row per declared secret table (`../tables/defineSecretTable`),
 * written by the migration `pithy migrate` generates for it, in the same secrets D1.
 *
 * **It exists because the rotation cannot import a declaration.** At-rest rotation runs in the prebuilt
 * `<project>-<env>-secrets` manager, which has `managerRegistry` compiled in and never sees the adopter's
 * `pithy.config.ts`. So the migration that creates a table also names it here, and the rotation sweeps
 * every name it reads — the manager is current the moment the migration lands, with no redeploy and no way
 * for a table to exist and quietly not rotate.
 *
 * `keys` is here because a row's ciphertext is bound to its owner (`secretTableContext`): re-encrypting one
 * means reading its key columns, and the manager learns which they are from this row and nowhere else. It
 * reads them and never writes one. `secrets` is the declared names, for `pithy secrets tables` to list.
 */
export const SecretTableRegistration = z
  .object({
    name: z
      .string()
      .describe("The declared table's name — `customer` for `pithy_secrets_customer_secrets`. Primary key."),
    keys: sqliteJson(
      z.array(z.string().describe("One owner key column, camelCase.")).describe("The owner key columns, in order."),
    ).describe("The table's owner key columns, as a JSON array — what the rotation reads to rebuild a row's context."),
    secrets: sqliteJson(
      z.array(z.string().describe("One declared secret name.")).describe("The declared secret names, in order."),
    ).describe("The secret names the table declares, as a JSON array."),
    createdAt: SQLiteDate.describe("When the table was first registered. Ms-epoch in SQLite, a `Date` in app code."),
    updatedAt: SQLiteDate.describe("When the registration last changed. Ms-epoch in SQLite, a `Date` in app code."),
  })
  .describe("One declared secret table the at-rest rotation sweeps (`pithy_secrets_tables`).");
export type SecretTableRegistration = z.output<typeof SecretTableRegistration>;
