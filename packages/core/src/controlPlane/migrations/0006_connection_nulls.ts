// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** The nullable columns `''` cannot satisfy, as they stood when this migration was written. */
const NULLABLE_COLUMNS = ["managementOrigin", "authorizedBy", "actorKind", "purpose"] as const;

/**
 * An empty nullable column reads as NULL again.
 *
 * `''` is not a value any of them accepts: not a URL, not an email, not an actor kind, shorter than a purpose.
 * A connection holding one cannot be read, so every call on it is refused, and the only writer of one bound NULL
 * as an empty string. So `''` in any of them is NULL, put back.
 *
 * `down` writes nothing. An empty string is not a state to return to: it is the one that refuses every call.
 */
export const controlplane_0006_connection_nulls: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    const table = db as unknown as Kysely<{ pithyControlplaneConnections: Record<string, string | null> }>;
    for (const column of NULLABLE_COLUMNS) {
      await table
        .updateTable("pithyControlplaneConnections")
        .set({ [column]: null })
        .where(column, "=", "")
        .execute();
    }
  },

  down: async (): Promise<void> => {},
};
