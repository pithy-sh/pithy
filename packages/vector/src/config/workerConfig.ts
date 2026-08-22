// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { MetadataIndexDescriptor, metadataIndexes } from "../index/metadata";
import type { VectorConfig } from "./config";
import { VectorMetric } from "./config";

/**
 * The vector config as the prebuilt reprocess worker receives it — a **serializable projection**, not the
 * config itself.
 *
 * `VectorConfig.indexes[x].metadata` holds a live `z.ZodObject`. A Zod schema is not JSON, so the media
 * pattern of stringifying the whole config into a `vars` entry cannot be copied here: the metadata field
 * would arrive as an unusable husk and every filter the worker compiled against it would be wrong. So the
 * worker gets what it actually needs — the model, the vector shape, the binding, the namespace, and the
 * *result* of introspecting the metadata schema (the filterable descriptors), which is plain data.
 *
 * The projection happens at provision time, on the CLI side, where the real schema exists. That means a
 * schema change reaches the worker only on the next `pithy vector provision` — which is correct, because a
 * new filterable field needs a metadata index provisioned before it can be filtered on anyway.
 */

/** One index as the worker sees it: everything needed to embed, write, and filter, with no Zod in sight. */
export const VectorWorkerIndex = z
  .object({
    indexName: z
      .string()
      .min(1)
      .describe("The provisioned Vectorize index name for this environment — what the binding addresses."),
    binding: z.string().min(1).describe("The wrangler binding this index arrives on in the worker's env."),
    model: z.string().min(1).describe("The Workers AI embedding model pinned to this index."),
    dimensions: z.number().int().positive().describe("How many components each vector carries."),
    metric: VectorMetric.describe("How this index scores nearest neighbors."),
    namespace: z.string().optional().describe("The namespace writes and queries use when a caller names none."),
    filterable: z
      .array(MetadataIndexDescriptor)
      .describe(
        "The metadata indexes this index declares, introspected from its Zod metadata schema at provision time. Plain data, because a Zod schema cannot travel through a wrangler var.",
      ),
  })
  .describe("One index as the prebuilt reprocess worker sees it — the serializable half of a VectorIndexConfig.");
export type VectorWorkerIndex = z.infer<typeof VectorWorkerIndex>;

/** The whole projection, keyed by the config's index names — the `VECTOR_CONFIG` var the worker parses. */
export const VectorWorkerConfig = z
  .object({
    indexes: z
      .record(z.string(), VectorWorkerIndex)
      .describe("Every index the worker may reprocess, keyed by the name used in pithy.config.ts and on routes."),
  })
  .describe("The vector capability's config as the prebuilt reprocess worker receives it: serializable, Zod-free.");
export type VectorWorkerConfig = z.infer<typeof VectorWorkerConfig>;

/**
 * Project a resolved config into the worker's view for one environment. `resolveIndexName` maps a config
 * index name to its provisioned Vectorize index name, so the same projection serves every environment.
 * Throws through {@link metadataIndexes} if a metadata schema is not provisionable — the same failure
 * `pithy vector provision` would hit, raised before a worker is deployed against it.
 */
export function toWorkerConfig(config: VectorConfig, resolveIndexName: (name: string) => string): VectorWorkerConfig {
  const indexes: Record<string, VectorWorkerIndex> = {};
  for (const [name, index] of Object.entries(config.indexes)) {
    indexes[name] = {
      indexName: resolveIndexName(name),
      binding: index.binding,
      model: index.model,
      dimensions: index.dimensions,
      metric: index.metric,
      ...(index.namespace !== undefined ? { namespace: index.namespace } : {}),
      filterable: index.metadata ? metadataIndexes(index.metadata) : [],
    };
  }
  return { indexes };
}
