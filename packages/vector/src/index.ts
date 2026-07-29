/**
 * The package entrypoint — the surface `pithy add vector` wires into `pithy.config.ts`. Deliberately narrow:
 * the capability factory, its config types, the `filterable` marker an adopter puts on a metadata field, and
 * the typed filter builder. Every other module is imported by deep path (`@pithy-sh/vector/src/...`); this is
 * the documented contract, not a barrel over the package.
 */

export {
  isVectorCapability,
  VECTOR_MIGRATION_ORDER,
  type VectorCapability,
  type VectorOptions,
  vector,
} from "./capability";
export {
  DEFAULT_VECTORIZE_BINDING,
  resolveIndex,
  VectorConfig,
  type VectorConfigInput,
  VectorIndexConfig,
  VectorMetric,
} from "./config/config";
export { VectorDocument, type VectorDocumentRow } from "./data/document";
export { filterable, type VectorFilter, vectorFilter } from "./index/filter";
export { type MetadataIndexDescriptor, metadataIndexes } from "./index/metadata";
export { vectorExampleSeed } from "./seeds/example";
export { VECTOR_CAPABILITY, VectorReprocessParams, vectorWorkflows } from "./workflows/specs";
