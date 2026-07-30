// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add media` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, its config and options types, the record and dedup API, and the
 * schemas an app extends. Every other module is imported by deep path (`@pithy-sh/media/src/...`); this
 * is the documented contract, not a barrel over the package.
 */

export { isMediaCapability, MEDIA_MIGRATION_ORDER, type MediaCapability, type MediaOptions, media } from "./capability";
export { MediaConfig, type MediaConfigInput, type MediaDelivery } from "./config/config";
export {
  EXTRACTABLE_EXTENSIONS,
  isExtractableDocument,
  MediaStatus,
  MediaType,
  StorageBackend,
} from "./data/enums";
export { extendMediaAsset } from "./data/extend";
export { MediaAsset } from "./data/mediaAsset";
export {
  buildImageUrl,
  buildStreamDashUrl,
  buildStreamHlsUrl,
  buildStreamIframeUrl,
  buildStreamThumbnailUrl,
  mediaUrl,
} from "./deliver/url";
export {
  classifyDistance,
  type DuplicateCandidate,
  findDuplicates,
  hammingDistance,
  SIMILAR_THRESHOLD,
} from "./hash/duplicates";
export { computeSha256 } from "./hash/sha256";
export type { HashStore } from "./record/hashStore";
export type { MediaRecord, RecordStore } from "./record/store";
