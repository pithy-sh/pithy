// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration } from "kysely/migration";
import { secrets_0001_init } from "./0001_init";
import { secrets_0002_tables } from "./0002_tables";

/**
 * The `secrets` database's migration chain, in one place — the capability composes it and the CLI's
 * provisioner runs it, and the two must be one list. A provisioner that ran `0001` alone against a vault the
 * capability had migrated to `0002` would read the ledger as corrupt and refuse.
 *
 * Append-only: `@pithy-sh/secrets` has shipped, so every entry here is history.
 */
export const secretsMigrations: Readonly<Record<string, Migration>> = {
  "0001_init": secrets_0001_init,
  "0002_tables": secrets_0002_tables,
};
