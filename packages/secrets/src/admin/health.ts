// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type CapabilityHealth, defineCapabilityHealth } from "@pithy-sh/core/src/controlPlane/discovery/health";
import { secretsStatusDatabase } from "../data/statusDb";
import { SECRETS_STATUS_READ_SCOPE } from "../http/guards";
import type { SecretRegistry } from "../registry";
import { readSecretStatus, type SecretStatusEntry, type SecretsStatusDb } from "./status";

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
 * How many of these entries are past their declared cadence — the one definition of "due", read by
 * the manifest count here and by the status route's own audit metadata.
 *
 * `overdue === true` and never merely truthy: the third state is null — nobody has said what late means
 * for that secret — and folding it into "not overdue" would be the same mistake as reporting a withheld
 * number as zero.
 *
 * **An unreadable entry is not counted, and the count is still a number (`#387`).** Before the per-row
 * guard, one malformed row threw out of `readSecretStatus` and this capability reported `unavailable` for
 * the whole manifest key — `#350` working exactly as designed, and still the wrong answer, because the
 * other secrets' freshness was knowable and went unreported. A secret whose row will not decode is now in
 * the same position as one that declares no cadence: nobody can say whether it is late, so it is not
 * asserted to be. That is a smaller lie than counting it either way, and a much smaller one than
 * withholding the number.
 */
export function dueForRotation(entries: readonly SecretStatusEntry[]): number {
  return entries.filter((entry) => entry.state === "readable" && entry.status.overdue === true).length;
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
