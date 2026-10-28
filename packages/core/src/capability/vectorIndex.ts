// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "../error/pithyError";

/**
 * A Vectorize index a capability owns and re-embeds itself — the contribution `pithy vector reprocess` reads.
 *
 * ## Why a contribution
 *
 * `@pithy-sh/vector` re-embeds the indexes an adopter declares in `vector({ indexes })`. A capability that
 * builds an index of its own — `@pithy-sh/support`'s semantic message index — uses vector's public modules to
 * embed and to re-embed, and runs vector's reprocess orchestration in a Workflow it hosts, over its own corpus.
 * What it cannot do is teach vector's CLI that the index exists: capabilities depend on core seams, never on
 * each other. So it says so here, on its own `Capability`, the way it states its migrations and its purge, and
 * `pithy vector reprocess` reads every composed declaration — in a project that never composes `vector()` too.
 *
 * ## What the CLI does with one
 *
 * It starts `reprocessJob`, one of this capability's own `workflows`, under the deployed name every Workflow
 * gets — `<project>-<env>-<capability>-<job>` — with the parameters every reprocess takes: `{ index, all }`.
 * A model change, a repair and a full rebuild (`--all`) are then the same three cases they are for any index.
 */
export interface VectorIndexContribution {
  /**
   * The index's name as `pithy vector reprocess --index` takes it — `support-messages`. Unique across the
   * project, and never one of the adopter's own `vector()` index keys.
   */
  readonly name: string;
  /** The job, in this capability's `workflows`, that re-embeds the index. */
  readonly reprocessJob: string;
}

/**
 * Refuse a declaration no reprocess could run: a duplicate name, or a job the capability does not register.
 * Called by `defineCapability`, so the mistake is named where it is written rather than on the day somebody
 * changes a model.
 */
export function assertVectorIndexContributions(
  capability: string,
  indexes: readonly VectorIndexContribution[],
  jobs: readonly string[],
): void {
  const seen = new Set<string>();
  for (const index of indexes) {
    if (seen.has(index.name)) {
      throw new InternalError({
        message: `The ${capability} capability declares the vector index \`${index.name}\` twice.`,
        detail: `vectorIndexes on ${capability} repeats ${index.name}`,
      });
    }
    seen.add(index.name);
    if (!jobs.includes(index.reprocessJob)) {
      throw new InternalError({
        message: `The ${capability} capability's vector index \`${index.name}\` names a reprocess job it does not register.`,
        detail: `vectorIndexes on ${capability}: no workflow job ${index.reprocessJob}; registered: ${jobs.join(", ") || "none"}`,
      });
    }
  }
}
