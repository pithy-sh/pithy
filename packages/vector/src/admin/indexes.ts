// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { VectorConfig, VectorIndexConfig } from "../config/config";
import type { CorpusState } from "../data/corpusState";
import type {
  VectorIndexesResponse,
  VectorIndexProvision,
  VectorIndexState,
  VectorIndexVectorize,
} from "../http/responses";
import { compareMetadataIndexes } from "../index/drift";
import { describeVectors, type VectorStore } from "../index/index";
import { metadataIndexes } from "../index/metadata";
import { provisionedIndex, provisionVectors, resetVectors, type VectorProvisionRecord } from "../index/provisioned";

/**
 * The control-plane read of every declared index (#730): what config declares, what Vectorize holds, what the
 * corpus holds, and where each stands against the provision record.
 *
 * **Three sources, and none needs an account token.** Config is in hand. Vectorize is the binding, on the
 * request path the way every other Vectorize call in this package is. The provision record is a var. So the
 * read adds nothing to the one `runtime` token, and `vector` declares no `runtimePermissions`.
 *
 * **Every declared index is reported, whatever state it is in.** An index provision never saw, one whose
 * binding is missing, and one whose `describe` throws are each a row with that state, never a row left out:
 * a client compares this list against config, and an omission reads as an index that does not exist.
 *
 * **Drift is what this read most needs to answer.** It is the state `provisionGuard` refuses every other route
 * in, and the admin surface is exempt from that guard so a client can tell a drifted Worker from one that is
 * down (#763).
 *
 * A record that is present and unreadable throws, from `readProvisionRecord`, before anything here runs. A
 * corrupted record cannot be compared against, and reporting it as no record would downgrade it to "never
 * provisioned".
 */

/** What the read needs, injected, so it is tested with no binding at all. */
export interface IndexReadDeps {
  /** The resolved vector config. */
  config: VectorConfig;
  /** What `pithy vector provision` last recorded, or undefined where it never ran. */
  record: VectorProvisionRecord | undefined;
  /** The environment the Worker serves, or undefined where nothing stamped one. */
  environment: string | undefined;
  /** The Vectorize binding one index arrives on, or undefined where the Worker has none. */
  store: (index: VectorIndexConfig) => VectorStore | undefined;
  /** The corpus counts. */
  corpus: CorpusState;
}

/**
 * Where one declared index stands against the record. Pure, and it applies the boot check's own rule —
 * `compareMetadataIndexes` — so the read and `provisionGuard` cannot disagree about what drift is.
 *
 * Absent from the record is **unprovisioned**, whether or not the index declares a filterable field: the
 * record is written per index, so an index it does not name is one provision never ran for. Present and
 * missing or mis-typing a declared field is **drifted**. A live metadata index config does not declare is
 * neither, as at boot: it may predate the config or belong to another consumer of the same index.
 */
export function provisionState(
  name: string,
  index: VectorIndexConfig,
  record: VectorProvisionRecord | undefined,
  environment: string | undefined,
): VectorIndexProvision {
  const observed = provisionedIndex(record, name);
  if (!observed) {
    return { state: "unprovisioned", message: provisionVectors(environment, `create \`${name}\``) };
  }
  const declared = index.metadata ? metadataIndexes(index.metadata) : [];
  const report = compareMetadataIndexes(declared, observed.metadataIndexes);
  if (report.missing.length === 0 && report.mismatched.length === 0) return { state: "provisioned" };
  const create = provisionVectors(environment, "create the missing metadata indexes, then redeploy and re-embed");
  return {
    state: "drifted",
    missing: report.missing.map((entry) => ({ propertyName: entry.propertyName, indexType: entry.indexType })),
    mismatched: report.mismatched.map((entry) => ({
      propertyName: entry.propertyName,
      declared: entry.declared,
      indexed: entry.live,
    })),
    message:
      report.mismatched.length === 0
        ? create
        : `${create} A mis-typed metadata index is fixed only by rebuilding the index from the corpus: ${resetVectors(environment)}`,
  };
}

/** What Vectorize says about one index, with the declared dimensions held against what it reports. */
async function vectorizeState(
  index: VectorIndexConfig,
  store: VectorStore | undefined,
  environment: string | undefined,
): Promise<VectorIndexVectorize> {
  const reading = await describeVectors(store);
  if (reading.state === "unreadable") return reading;
  return {
    ...reading,
    dimensionMismatch:
      reading.dimensions === index.dimensions
        ? null
        : {
            declared: index.dimensions,
            actual: reading.dimensions,
            message: `Config declares ${index.dimensions} dimensions and the index was created with ${reading.dimensions}. Dimensions are fixed at creation, so writes and queries against it fail until one side changes. Edit config to match, or rebuild the index: ${resetVectors(environment)}`,
          },
  };
}

/** One declared index, read three ways. The reads are independent, so they run together. */
async function indexState(deps: IndexReadDeps, name: string, index: VectorIndexConfig): Promise<VectorIndexState> {
  const [vectorize, documents, namespaces] = await Promise.all([
    vectorizeState(index, deps.store(index), deps.environment),
    deps.corpus.embedding(name, index.model),
    deps.corpus.namespaces(name),
  ]);
  return {
    name,
    declared: { model: index.model, dimensions: index.dimensions, metric: index.metric },
    vectorize,
    documents,
    namespaces,
    provision: provisionState(name, index, deps.record, deps.environment),
  };
}

/** Read every declared index, in config order. */
export async function readIndexes(deps: IndexReadDeps): Promise<VectorIndexesResponse> {
  const indexes = await Promise.all(
    Object.entries(deps.config.indexes).map(([name, index]) => indexState(deps, name, index)),
  );
  return { environment: deps.environment ?? null, indexes };
}
