// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MediaConfig } from "../config/config";
import type { MediaType, StorageBackend } from "../data/enums";

/**
 * Resolve which storage backend a media type uses from config. Images and video are configurable
 * (`r2` | `cf-images`, `r2` | `cf-stream`); audio and documents are always R2.
 */
export function backendForType(type: MediaType, config: MediaConfig): StorageBackend {
  switch (type) {
    case "image":
      return config.images.store;
    case "video":
      return config.video.store;
    case "audio":
    case "document":
      return "r2";
  }
}

/**
 * The R2 object key for a media record: `media/<type>/<id>`. Namespaced under `media/` so a shared
 * bucket never collides with an adopter's own objects, and partitioned by type for clarity.
 */
export function mediaR2Key(type: MediaType, id: string): string {
  return `media/${type}/${id}`;
}
