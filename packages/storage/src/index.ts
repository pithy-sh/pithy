/**
 * The package entrypoint — the surface `pithy add storage` wires into `pithy.config.ts`.
 *
 * Deliberately narrow: the capability factory and its config, the {@link ObjectStore} seam another
 * capability holds to move bytes (`@pithy-sh/media` is the first), the registry factory that makes a
 * second bucket's credentials resolvable, and the table schemas an adopter reads rows against. Every
 * other module is imported by deep path (`@pithy-sh/storage/src/...`); this is the documented
 * contract, not a barrel over the package.
 */

export {
  isStorageCapability,
  STORAGE_MIGRATION_ORDER,
  type StorageCapability,
  type StorageOptions,
  storage,
} from "./capability";
export { maxObjectBytes, StorageConfig, type StorageConfigInput, StorageQuota } from "./config/config";
export { StorageShare } from "./data/share";
export { StorageObject, StorageObjectStatus, StorageVisibility } from "./data/storageObject";
export { STORAGE_OBJECTS_TABLE, STORAGE_SHARES_TABLE, type StorageDatabase, storageDatabase } from "./data/tables";
export { deriveObjectKey, isDerivedObjectKey, OBJECT_KEY_PREFIX } from "./object/key";
export { collectParts, MultipartPlan, needsMultipart, PartPlan, planMultipart, ReportedPart } from "./object/multipart";
export {
  ObjectListing,
  ObjectMetadata,
  type ObjectStore,
  type ObjectStoreOptions,
  objectStore,
  type PresignedObjects,
} from "./object/store";
export {
  R2StorageCredentials,
  r2CredentialsRegistry,
  STORAGE_R2_SECRET,
  storageSecretsRegistry,
} from "./secret/registry";
export { STORAGE_CAPABILITY, StorageSweepParams, storageWorkflows } from "./workflows/specs";
export { type SweepDeps, type SweepResult, sweepStorage } from "./workflows/sweep";
