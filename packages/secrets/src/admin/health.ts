// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type CapabilityHealth, defineCapabilityHealth } from "@pithy-sh/core/src/controlPlane/discovery/health";
import { secretsStatusDatabase } from "../data/statusDb";
import { SECRETS_STATUS_READ_SCOPE } from "../http/guards";
import type { SecretRegistry } from "../registry";
import { readSecretStatus, type SecretStatus, type SecretsStatusDb } from "./status";

/**
 * What this capability contributes to its manifest entry: one number, so a management client can say
 * "3 secrets need rotating" from the read it already made (#317).
 *
 * ## Why a count belongs on the manifest and the list does not
 *
 * The list is `GET {base}/admin/status`, and it stays there. What a rail needs is whether the detail is
 * worth fetching, and that is one scalar. Anything more — which secrets, since when — grows with the
 * adopter's registry and would turn a discovery read into a data API.
 *
 * ## What it costs, stated
 *
 * Exactly what the status read costs, because it *is* the status read: one `where name in (...)` against
 * `pithy_secrets_system_secrets`, where `name` is unique, and one grouped `where name in (...)` against
 * `pithy_secrets_rotations`, where `name` is indexed (`pithySecretsRotationsNameIdx`). Both are bounded
 * by how many secrets the composed registry *declares* — a number in the adopter's source — and never by
 * how many rows they hold. That is what `cost: "indexed"` claims, and it is the whole reason this may
 * sit on the most frequently fetched read the seam serves.
 *
 * ## One definition of late
 *
 * The count is derived from {@link readSecretStatus} rather than from a second query that re-decides
 * what overdue means. A secret whose registry entry declares no cadence, or that has nothing to measure
 * from, reports `overdue: null` there and is not counted here: nobody has said what late means for it,
 * and counting it would be an opinion the capability does not hold.
 */

/** The key the count appears under. Exported so a client and a test name it from one place. */
export const SECRETS_DUE_FOR_ROTATION = "secretsDueForRotation";

/**
 * How many of these statuses are past their declared cadence — the one definition of "due", read by
 * the manifest count here and by the status route's own audit metadata.
 *
 * `overdue === true` and never merely truthy: the third state is null — nobody has said what late means
 * for that secret — and folding it into "not overdue" would be the same mistake as reporting a withheld
 * number as zero.
 */
export function dueForRotation(statuses: readonly SecretStatus[]): number {
  return statuses.filter((status) => status.overdue === true).length;
}

/** How many declared secrets are past the cadence their registry entry declares. */
export async function countSecretsDueForRotation(
  db: SecretsStatusDb,
  registry: SecretRegistry,
  now?: Date,
): Promise<number> {
  return dueForRotation(await readSecretStatus(db, registry, now ? { now } : {}));
}

/**
 * The capability's health summary, over the registry it actually composed.
 *
 * A thunk for the same reason the status routes take one: the set worth reporting is every capability's
 * combined registry, and that only exists after `compose` has run.
 */
export function secretsHealth(registry: () => SecretRegistry): CapabilityHealth {
  return defineCapabilityHealth({
    keys: [
      {
        key: SECRETS_DUE_FOR_ROTATION,
        kind: "count",
        states: null,
        // The scope the status read is already behind. A count is a smaller disclosure than the listing
        // it summarises, but it is a disclosure of the same thing — which credentials are stale is a map
        // of where to push — so an adopter who withheld the listing withholds the number with it.
        scope: SECRETS_STATUS_READ_SCOPE,
        cost: "indexed",
        summary: "Secrets past the rotation cadence their registry entry declares.",
      },
    ],
    read: async (c) => ({
      [SECRETS_DUE_FOR_ROTATION]: await countSecretsDueForRotation(secretsStatusDatabase(c), registry()),
    }),
  });
}
