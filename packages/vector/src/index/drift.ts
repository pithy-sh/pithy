// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { VectorMetadataIndexDriftError } from "../error/errors";
import type { MetadataIndexDescriptor, MetadataIndexType } from "./metadata";

/**
 * The check that a declared filterable field actually has a live metadata index.
 *
 * A declared-but-missing metadata index is **fatal**. Failing loudly is deliberate, and the alternative is
 * worse than it looks. Auto-create-and-warn produces two things: a warning in a log nobody reads, and a search
 * that returns partial results for every vector written before the index existed — because Cloudflare states,
 * verbatim, *"Vectors upserted before a metadata index was created won't have their metadata contained in that
 * index."* Nothing errors. The filter just quietly stops matching most of the corpus, and the bug surfaces
 * weeks later as "search feels wrong", which is close to untraceable.
 *
 * **The live comparison runs where the control plane is reachable, which is the CLI — not inside the
 * Worker.** `listMetadataIndexes` is a Cloudflare REST call, and the only credential that authorizes it is an
 * account API token. Handing a Worker one so it could self-check at boot would put a control-plane token on
 * the request path of every search, which is a far worse trade than the bug it would catch. So the live
 * comparison happens in `pithy vector provision`, which already holds the token.
 * {@link assertMetadataIndexes} is the strict form of it, for a caller that wants drift to be an error rather
 * than a report.
 *
 * The Worker still checks — it just checks offline. Provisioning writes down what it observed, and
 * `index/provisioned.ts` compares the config's declarations against that record at boot, reusing
 * {@link compareMetadataIndexes} so both halves apply one rule. That check proves the config declares nothing
 * provisioning did not see *the last time it ran*; it does not prove anything about Cloudflare right now. It
 * catches the case that actually happens: a metadata schema edited and deployed without re-provisioning.
 *
 * A live index the config does not declare is **not** fatal. It may predate the config, or belong to another
 * consumer of the same Vectorize index, and deleting it is destructive; it is reported so `pithy vector
 * provision` can surface it, because it still spends one of the ten slots.
 */

/** A metadata index whose live type does not match the type the schema declares. */
export interface MetadataIndexMismatch {
  /** The metadata property. */
  propertyName: string;
  /** The type the config's metadata schema declares. */
  declared: MetadataIndexType;
  /** The type the live index was created with. */
  live: string;
}

/** What one comparison of declared against live metadata indexes found. */
export interface MetadataIndexReport {
  /** Declared filterable, with no live metadata index. Fatal: filters on these silently return partial results. */
  missing: MetadataIndexDescriptor[];
  /** Declared and live, but indexed as a different type. Fatal: comparisons against the wrong type never match. */
  mismatched: MetadataIndexMismatch[];
  /** Live, but not declared. Not fatal — but it still spends one of the ten metadata-index slots. */
  extra: { propertyName: string; indexType: string }[];
}

/** The subset of the Vectorize control plane this check reads. Structural, so a test injects a fake. */
export interface MetadataIndexSource {
  /** The metadata indexes that exist on an index right now. */
  listMetadataIndexes(indexName: string): Promise<{ propertyName: string; indexType: string }[]>;
}

/** Compare what the schema declares against what the index has. Pure — no network, so it is trivially tested. */
export function compareMetadataIndexes(
  declared: readonly MetadataIndexDescriptor[],
  live: readonly { propertyName: string; indexType: string }[],
): MetadataIndexReport {
  const liveByName = new Map(live.map((index) => [index.propertyName, index]));
  const declaredNames = new Set(declared.map((index) => index.propertyName));

  const missing: MetadataIndexDescriptor[] = [];
  const mismatched: MetadataIndexMismatch[] = [];
  for (const index of declared) {
    const match = liveByName.get(index.propertyName);
    if (!match) {
      missing.push(index);
      continue;
    }
    if (match.indexType !== index.indexType) {
      mismatched.push({ propertyName: index.propertyName, declared: index.indexType, live: match.indexType });
    }
  }

  const extra = live.filter((index) => !declaredNames.has(index.propertyName)).map((index) => ({ ...index }));
  return { missing, mismatched, extra };
}

/**
 * Fetch the live metadata indexes and refuse to continue if any declared one is missing or mis-typed. Returns
 * the full report so a caller — `pithy vector doctor`, provisioning — can also surface the undeclared ones.
 *
 * Takes a {@link MetadataIndexSource} rather than reaching for one, because the only thing that can implement
 * it is a control-plane client holding an API token. That is the CLI, never the Worker.
 */
export async function assertMetadataIndexes(
  source: MetadataIndexSource,
  indexName: string,
  declared: readonly MetadataIndexDescriptor[],
): Promise<MetadataIndexReport> {
  const report = compareMetadataIndexes(declared, await source.listMetadataIndexes(indexName));

  if (report.missing.length > 0 || report.mismatched.length > 0) {
    const missing = report.missing.map((index) => `${index.propertyName} (${index.indexType})`);
    const mismatched = report.mismatched.map(
      (index) => `${index.propertyName} (declared ${index.declared}, indexed as ${index.live})`,
    );
    throw new VectorMetadataIndexDriftError({
      message: `Search on \`${indexName}\` is not configured correctly.`,
      action: `Run \`pithy vector provision\` to create the missing metadata indexes on \`${indexName}\`, then re-embed — Vectorize does not index vectors written before an index existed.`,
      detail: [
        missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
        mismatched.length > 0 ? `mismatched: ${mismatched.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    });
  }

  return report;
}
