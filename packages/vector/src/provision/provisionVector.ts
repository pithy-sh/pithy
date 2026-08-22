// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { VectorConfig } from "../config/config";
import type { MetadataIndexReport } from "../index/drift";
import { type MetadataIndexDescriptor, metadataIndexes } from "../index/metadata";
import type { ObservedMetadataIndex, ProvisionedIndex, VectorProvisionRecord } from "../index/provisioned";
import { VECTOR_CAPABILITY } from "../workflows/specs";

/**
 * The provisioning orchestration for the vector capability — the live counterpart to `pithy add vector`'s
 * config wiring. `pithy add` writes the bindings it can; this creates what they point at.
 *
 * The `vectorize` and `workflows` bindings are not among the ones it can. Wrangler requires an `index_name`
 * on the first and a `name` + `class_name` on the second, and every one of those values is an output of this
 * run — so `add` writes neither (a partial entry stops wrangler loading the config at all) and the CLI writes
 * both, complete, after provisioning succeeds.
 *
 * **The order is the whole contract.** An index is created, then every metadata index its schema declares,
 * and only then is the worker that writes vectors deployed. Cloudflare states it plainly: *"Vectors upserted
 * before a metadata index was created won't have their metadata contained in that index."* A vector written
 * into the window between those two steps is permanently invisible to any filter on that field — no error,
 * no warning, just a search that quietly returns less than it should. Doing this in the wrong order is
 * unrecoverable without a full re-embed, which is exactly why the order lives in tested code rather than in
 * a runbook.
 *
 * The live Cloudflare/wrangler steps sit behind the {@link VectorProvisioner} seam, so the ordering and the
 * idempotency contract are unit-tested without an account. **Every step is idempotent** — find-then-create
 * for the index and its metadata indexes, and a deploy that overwrites — so a re-run reconciles rather than
 * fails. Vectorize applies both index and metadata-index changes asynchronously, so nothing here writes and
 * immediately reads back.
 */

/**
 * The Vectorize index name for one configured index in one environment —
 * `<project>-<env>-vector-<index>`.
 *
 * Per environment, never shared: a staging index and a prod index that share vectors mean staging's
 * test corpus answers prod's searches, and a staging teardown deletes prod's embeddings.
 *
 * Per **project** for a sharper reason. Vectorize's index namespace is account-wide, and provisioning
 * reuses an index it finds by name — so an unscoped `pithy-vector-docs-prod` would let a second Pithy
 * project adopt this one's index, mix two corpora into one search, and delete both on either teardown.
 * Dimensions and metric are fixed at creation, so the adoption would also silently pin the second
 * project to the first's embedding model.
 *
 * **Composed through the naming facade**, which carries Vectorize's own rule: 64 bytes — not the 63
 * every namespace was once held to — refused rather than truncated, because a shortened index name is
 * a *different, empty* index and re-embedding a corpus is neither free nor quick. The facade also
 * validates the project once and the environment once, so `production` is refused here rather than
 * standing up a fourth environment nothing else knows about.
 */
export function vectorIndexName(project: string, index: string, env: string): string {
  const scope = resourceNames(project).env(env);
  try {
    return scope.vectorizeIndex(`${VECTOR_CAPABILITY}-${index}`);
  } catch (error) {
    // The facade refuses an over-long Vectorize name as an `InternalError`, on the reasoning that the
    // project and the environment are already validated so only author code can overflow it. That
    // reasoning does not hold here: the trailing segment is a key out of the adopter's
    // `pithy.config.ts`, and config validates it against Vectorize's 64 without knowing what the
    // project and environment will spend of it. So the refusal is restated in the adopter's terms —
    // same limit, same number, named as the fixable thing it is.
    if (!(error instanceof PithyError)) throw error;
    throw new ValidationError({
      message: `The \`${index}\` index cannot be named: ${error.payload.message}`,
      action: `Shorten the \`${index}\` index's key in pithy.config.ts, or the project name — the deployed name is <project>-<env>-${VECTOR_CAPABILITY}-<index>.`,
      detail: error.payload.detail ?? error.payload.message,
    });
  }
}

/** The shape an index is created with. Fixed at creation — neither value can be changed afterwards. */
export interface VectorIndexShape {
  /** Components per vector, matching the model that fills the index. */
  dimensions: number;
  /** How nearest neighbors are scored. */
  metric: "cosine" | "euclidean" | "dot-product";
}

/** The live Cloudflare/wrangler seam. Each step must be idempotent. */
export interface VectorProvisioner {
  /** Verify account prerequisites before anything is created (a workers.dev subdomain, Vectorize access). */
  preflight(): Promise<void>;
  /** Create (or reuse) the index. Idempotent — an existing index with the same shape is reused as-is. */
  ensureIndex(indexName: string, shape: VectorIndexShape): Promise<{ name: string }>;
  /**
   * Create every declared metadata index that is missing, and report what was found. Idempotent.
   *
   * **Returning is the guarantee.** An implementation returns only once every declared index is live on the
   * index — waiting out Cloudflare's asynchronous apply — and throws otherwise. That is what lets
   * {@link provisionVector} record the declared set as observed, and what keeps the very next step (deploying
   * the worker that writes vectors) out of the window where a write would be permanently unfilterable.
   */
  ensureMetadataIndexes(indexName: string, declared: readonly MetadataIndexDescriptor[]): Promise<MetadataIndexReport>;
  /** Deploy the prebuilt vector worker for this environment, bound to the provisioned indexes. */
  deployWorker(env: string, indexNames: Record<string, string>): Promise<void>;
  /** Delete an index and everything in it. **Destructive** — every vector is lost. Idempotent. */
  deleteIndex(indexName: string): Promise<void>;
  /** Start a reprocess run for one configured index and wait for it. */
  reprocess(env: string, index: string, options: { all?: boolean; filter?: Record<string, unknown> }): Promise<unknown>;
}

/** What provisioning did for one configured index. */
export interface VectorIndexResult {
  /** The config's name for the index. */
  index: string;
  /** The Vectorize index name it was provisioned as. */
  indexName: string;
  /** The metadata indexes created on this run — empty on a re-run, which is what idempotent looks like. */
  created: MetadataIndexDescriptor[];
  /** Metadata indexes that exist but the config does not declare. Not fatal; they still spend a slot. */
  extra: { propertyName: string; indexType: string }[];
  /**
   * Every metadata index live on this index when provisioning finished: the declared ones (each confirmed
   * visible by `ensureMetadataIndexes`, which throws rather than return early) plus the undeclared ones.
   * This is what {@link toProvisionRecord} writes into the Worker's env, and what the Worker's boot check
   * compares its declarations against.
   */
  observed: ObservedMetadataIndex[];
}

/** What provisioning produced. */
export interface VectorProvisionResult {
  /** The environment provisioned. */
  env: string;
  /** Each configured index, with what was created for it. */
  indexes: VectorIndexResult[];
}

/** Provisioning inputs: the resolved config, the project that owns it, and the environment to stand it up in. */
export interface VectorProvisionOptions {
  /**
   * The project name — the `<project>` segment every index name leads with. The root
   * `pithy.config.ts` `name`, resolved by `requireProjectName` and never guessed: an index found by
   * name is *reused*, so a wrong value adopts another project's corpus.
   */
  project: string;
  /** The app's resolved vector config. */
  config: VectorConfig;
  /** The environment to provision. Vectorize has no local emulation, so `dev` is a real remote index too. */
  env: string;
}

/** The declared metadata indexes for one configured index, or none when it declares no metadata schema. */
function declaredIndexes(config: VectorConfig, index: string): MetadataIndexDescriptor[] {
  const metadata = config.indexes[index]?.metadata;
  return metadata ? metadataIndexes(metadata) : [];
}

/**
 * Provision every configured index for one environment: the index, then its metadata indexes, then the
 * worker that will write to it. Idempotent end to end.
 */
export async function provisionVector(
  provisioner: VectorProvisioner,
  options: VectorProvisionOptions,
): Promise<VectorProvisionResult> {
  await provisioner.preflight();

  const indexNames: Record<string, string> = {};
  const indexes: VectorIndexResult[] = [];

  for (const [index, indexConfig] of Object.entries(options.config.indexes)) {
    const indexName = vectorIndexName(options.project, index, options.env);
    await provisioner.ensureIndex(indexName, { dimensions: indexConfig.dimensions, metric: indexConfig.metric });

    // Immediately after the index, and before any worker that could write to it exists.
    const declared = declaredIndexes(options.config, index);
    const report = await provisioner.ensureMetadataIndexes(indexName, declared);

    indexNames[index] = indexName;
    indexes.push({
      index,
      indexName,
      created: report.missing,
      extra: report.extra,
      // `ensureMetadataIndexes` returned, so every declared index is live. Record the declarations rather
      // than re-listing the index: a fresh list would be a second eventually-consistent read, and could
      // report an index that was just confirmed as absent again.
      observed: [...declared, ...report.extra],
    });
  }

  // The worker last: it is the thing that writes vectors, and every metadata index now exists.
  await provisioner.deployWorker(options.env, indexNames);

  return { env: options.env, indexes };
}

/**
 * Project a provisioning result into the record the Worker boots against — the `VECTOR_PROVISIONED` var.
 *
 * This is the whole reason the Worker can check drift without a Cloudflare token: provisioning already holds
 * one, already compared declared against live, and writes down what it saw. The record is therefore a
 * statement about the last provisioning run, not about Cloudflare now, and the boot check says so.
 */
export function toProvisionRecord(result: VectorProvisionResult): VectorProvisionRecord {
  const indexes: Record<string, ProvisionedIndex> = {};
  for (const entry of result.indexes) {
    indexes[entry.index] = { indexName: entry.indexName, metadataIndexes: entry.observed };
  }
  return { indexes };
}

/** What a reset did. */
export interface VectorResetResult extends VectorProvisionResult {
  /** The indexes that were deleted and rebuilt, by their Vectorize names. */
  deleted: string[];
  /** The reprocess runs started, one per configured index. */
  reprocessed: string[];
}

/**
 * Delete every configured index, rebuild it, re-provision its metadata indexes, and re-embed the corpus.
 *
 * This is the repair for the one failure Vectorize cannot repair in place: a metadata index added after
 * vectors were written covers none of them, and there is no backfill. Rebuilding the index and re-embedding
 * from the document corpus is the only way back — which is the third reason `pithy_vector_documents` exists.
 *
 * **Destructive by definition.** Every vector is deleted; only the D1 corpus survives, and only what it holds
 * comes back. The confirmation gate lives in the CLI, where the environment is known.
 */
export async function resetVector(
  provisioner: VectorProvisioner,
  options: VectorProvisionOptions,
): Promise<VectorResetResult> {
  await provisioner.preflight();

  const deleted: string[] = [];
  for (const index of Object.keys(options.config.indexes)) {
    const indexName = vectorIndexName(options.project, index, options.env);
    await provisioner.deleteIndex(indexName);
    deleted.push(indexName);
  }

  // Rebuild through the ordinary path, so creation order and the metadata-index rule are stated once.
  const provisioned = await provisionVector(provisioner, options);

  const reprocessed: string[] = [];
  for (const index of Object.keys(options.config.indexes)) {
    // `all`: the rebuilt index holds nothing, so every document must be re-embedded regardless of its model.
    await provisioner.reprocess(options.env, index, { all: true });
    reprocessed.push(index);
  }

  return { ...provisioned, deleted, reprocessed };
}
