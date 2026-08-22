// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { byteLength, DEFAULT_TOPK, MAX_DIMENSIONS, MAX_NAME_BYTES, MAX_TOPK_WITHOUT_PAYLOAD } from "../index/limits";
import { introspectMetadata } from "../index/metadata";

/**
 * The vector capability's config — the thin, user-owned surface in `pithy.config.ts`. Every field is
 * `.describe()`d: the descriptions feed the self-documenting CLI (CLAUDE.md §Config).
 *
 * An index is declared, not discovered. It names the embedding model that fills it, the vector shape that
 * model produces, the metric to compare by, and — the part that matters — a Zod object describing the
 * metadata its vectors carry, with the filterable fields marked. That one declaration drives four things
 * that must never disagree: the metadata indexes `pithy vector provision` creates, the type of the filter
 * builder, the drift check that same command runs against the live index, and the boot check the Worker runs
 * against what that command recorded — which is how a schema edited and deployed without re-provisioning
 * fails loudly instead of returning partial results.
 *
 * The model is pinned per index because an index built with one model and queried with another does not
 * fail. It returns neighbors in a space the query vector does not live in — plausible results, quietly
 * wrong. Dimensions and metric are fixed at index creation and cannot be changed afterwards, so they are
 * validated here, where the fix is an edit rather than a migration.
 */

/** An index name is a path segment and a Cloudflare resource name, so it is lowercase, digits, and dashes. */
const INDEX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** A wrangler binding name: uppercase, digits, underscores. The env key the Vectorize index arrives on. */
const BINDING_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** The binding an index arrives on when it does not name its own. The single-index case, which is most of them. */
export const DEFAULT_VECTORIZE_BINDING = "VECTORIZE";

/** How nearest neighbors are scored. Fixed when the index is created — changing it means a new index. */
export const VectorMetric = z
  .enum(["cosine", "euclidean", "dot-product"])
  .describe(
    "How this index scores nearest neighbors. `cosine` for text embeddings (the usual choice), `euclidean` for spatial distance, `dot-product` for magnitude-sensitive scoring. Fixed at index creation.",
  );
export type VectorMetric = z.infer<typeof VectorMetric>;

/**
 * A metadata schema: a Zod object, not a value. It is held as a schema so this package can introspect it —
 * one pass yields the metadata indexes to provision and the type of the filter builder.
 */
const MetadataObject = z
  .custom<z.ZodObject>((value) => value instanceof z.ZodObject, {
    message: "An index's `metadata` must be a Zod object schema — z.object({ ... }), not a value.",
  })
  .describe(
    "The metadata every vector in this index carries, as a Zod object. Mark a field `.meta({ filterable: true })` — beside its `.describe()` — to make it filterable; each marked field becomes a Vectorize metadata index, and Vectorize allows ten per index.",
  );

export const VectorIndexConfig = z
  .object({
    model: z
      .string()
      .min(1)
      .describe(
        "The Workers AI embedding model that fills this index — `@cf/baai/bge-base-en-v1.5` and friends. Pinned per index and applied to writes *and* queries: an index built with one model and queried with another returns plausible, quietly wrong results.",
      ),
    dimensions: z
      .number()
      .int()
      .min(1)
      .max(MAX_DIMENSIONS)
      .describe(
        `How many components each vector carries. It must match the model's output — 768 for bge-base, 1024 for bge-large. Vectorize allows at most ${MAX_DIMENSIONS}, and the value is fixed at index creation.`,
      ),
    metric: VectorMetric.default("cosine"),
    binding: z
      .string()
      .regex(BINDING_NAME_PATTERN)
      .default(DEFAULT_VECTORIZE_BINDING)
      .describe(
        "The wrangler binding this index arrives on. One Vectorize binding addresses exactly one index, so a project with two indexes names two bindings — leaving both on the default would silently point one index's writes at the other's vectors.",
      ),
    metadata: MetadataObject.optional(),
    namespace: z
      .string()
      .optional()
      .describe(
        "The namespace writes and queries use when a caller names none. Namespaces partition one index — a tenant, a locale, a corpus — and are cheaper than one index per partition.",
      ),
  })
  .describe("One vector index: the model that fills it, the shape it holds, and the metadata it can filter on.");
export type VectorIndexConfig = z.output<typeof VectorIndexConfig>;

export const VectorConfig = z
  .object({
    indexes: z
      .record(z.string(), VectorIndexConfig)
      .prefault({})
      .describe(
        "Every index this app searches, keyed by a short name used in routes and in `pithy vector provision`. Indexes are config, not database rows — their shape is fixed at creation, so they belong where a change is reviewable. Defaults to none: `pithy add vector` can only seed scalar options, so the capability has to compose before an index block is hand-written, or the generated `pithy.config.ts` would fail to load and take every other `pithy` command down with it. With no index configured, the routes answer `vector/index_not_found` and the drift check has nothing to compare — which is the honest state of a capability that is installed but not yet set up.",
      ),
    defaultTopK: z
      .number()
      .int()
      .min(1)
      .max(MAX_TOPK_WITHOUT_PAYLOAD)
      .default(DEFAULT_TOPK)
      .describe(
        "How many matches a query returns when the caller names no `topK`. A search page, not a scan. Vectorize's own ceiling is 50 per query when values or metadata come back, 100 when neither does.",
      ),
  })
  .describe("Configuration for the vector capability — the set of indexes this app searches.")
  .check((ctx) => {
    const names = Object.keys(ctx.value.indexes);
    const bindings = new Map<string, string>();

    // No index is a legal, if inert, state — deliberately, and it is the state `pithy add vector`
    // leaves behind. `renderRegistration` can only seed scalar config options, so the generated
    // `pithy.config.ts` reads `vector({ defaultTopK: 10 })` with no `indexes` block; rejecting that
    // would make the file throw on load, and `loadProject` sits under every other `pithy` command —
    // including the `pithy migrate` that `pithy add` runs immediately afterwards. The command would
    // break the project it was asked to set up. An unconfigured capability that answers
    // `vector/index_not_found` is the honest intermediate state; a config that cannot be loaded is not.

    for (const name of names) {
      if (!INDEX_NAME_PATTERN.test(name)) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["indexes", name],
          message: `Index name \`${name}\` must be lowercase letters, digits, and dashes — it is a Cloudflare resource name and a path segment.`,
        });
      }
      if (byteLength(name) > MAX_NAME_BYTES) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["indexes", name],
          message: `Index name \`${name}\` is longer than ${MAX_NAME_BYTES} bytes, which Vectorize rejects.`,
        });
      }

      const index = ctx.value.indexes[name];
      if (!index) continue;

      // A Vectorize binding addresses one index. Two indexes sharing a binding is not a warning case:
      // every write to one would land in the other, and nothing would error.
      const shared = bindings.get(index.binding);
      if (shared !== undefined) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["indexes", name, "binding"],
          message: `Indexes \`${shared}\` and \`${name}\` both bind \`${index.binding}\`. One binding addresses one index — give each index its own.`,
        });
      } else {
        bindings.set(index.binding, name);
      }

      if (index.namespace !== undefined && byteLength(index.namespace) > MAX_NAME_BYTES) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: ["indexes", name, "namespace"],
          message: `Namespace \`${index.namespace}\` is longer than ${MAX_NAME_BYTES} bytes, which Vectorize rejects.`,
        });
      }

      // Introspect here, at parse time, so an unindexable field or an eleventh filterable one fails on deploy
      // — not at provisioning time, where the first ten indexes already exist and the eleventh is silently
      // absent from every filter that names it.
      if (index.metadata) {
        for (const problem of introspectMetadata(index.metadata).problems) {
          ctx.issues.push({ code: "custom", input: ctx.value, path: ["indexes", name, "metadata"], message: problem });
        }
      }
    }
  });
export type VectorConfig = z.output<typeof VectorConfig>;
export type VectorConfigInput = z.input<typeof VectorConfig>;

/** The index with this name, or undefined. Names come from config, so an unknown one is a 404. */
export function resolveIndex(config: VectorConfig, name: string): VectorIndexConfig | undefined {
  return config.indexes[name];
}
