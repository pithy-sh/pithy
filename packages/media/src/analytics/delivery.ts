// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  type AnalyticsDataset,
  type CloudflareAnalyticsManager,
  type DatasetLimits,
  IMAGE_REQUESTS,
  STREAM_MINUTES,
} from "@pithy-sh/cloudflare/src/analytics/analyticsManager";
import type { MediaConfig } from "../config/config";
import type { MediaType, StorageBackend } from "../data/enums";
import { MediaAnalyticsUnavailableError, MediaAnalyticsWindowError } from "../error/errors";
import type { ImageDelivery, MediaDeliveryResponse, VideoDelivery } from "../http/responses";
import type { StoredAssetReader } from "./assets";

/**
 * **What this environment's media was served, read from Cloudflare and joined to its own assets (#728).**
 *
 * The datasets are account-wide: a staging and a production Worker on one account read the same numbers.
 * The join is what scopes them. Each environment has its own database, so the asset rows read here are
 * this environment's and nobody else's, and Cloudflare is only ever asked about the keys those rows hold —
 * a Stream uid or an Images id another environment owns is never in the filter, so it can never be in the
 * answer. No account total is reported, because one cannot be scoped.
 */

/** The default window, in days, ending now. Fits every dataset read here: hosted Images answers 30 days and an hour. */
export const DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** A resolved window: `since` inclusive, `until` exclusive. */
export interface DeliveryWindow {
  since: Date;
  until: Date;
}

/** The slice of {@link CloudflareAnalyticsManager} this read uses — what a test hands in instead. */
export type DeliverySource = Pick<
  CloudflareAnalyticsManager,
  "datasetLimits" | "streamMinutesViewed" | "imageRequests"
>;

/** What the read needs. */
export interface DeliveryDeps {
  /** Every stored asset of one type on one backend, from this environment's own database. */
  assets: StoredAssetReader;
  /** The resolved media config — which backend each type is stored in. */
  config: MediaConfig;
  /**
   * The analytics reader, built only when a type is stored somewhere Cloudflare counts. Lazy, so a Worker
   * storing everything in R2 never reads the token it would need.
   */
  source: () => Promise<DeliverySource>;
  /** The clock. */
  now: () => Date;
}

/** One type the read can report, and how. */
interface Measured {
  type: MediaType;
  backend: StorageBackend;
  dataset: AnalyticsDataset;
  /** The dataset as an operator would say it. */
  label: string;
}

const VIDEO: Measured = { type: "video", backend: "cf-stream", dataset: STREAM_MINUTES, label: "Stream minutes" };
const IMAGES: Measured = { type: "image", backend: "cf-images", dataset: IMAGE_REQUESTS, label: "Images requests" };

/** Whole days in a span of seconds, for a cap stated to a person. */
function days(seconds: number): number {
  return Math.floor(seconds / 86_400);
}

/**
 * The window a request asks for: the last {@link DEFAULT_WINDOW_DAYS} days by default, a `since` alone
 * running to now, and an `until` alone reaching back the default span. A window that ends before it
 * starts is refused.
 */
export function resolveWindow(input: { since?: Date; until?: Date }, now: Date): DeliveryWindow {
  const until = input.until ?? now;
  const since = input.since ?? new Date(until.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (since.getTime() >= until.getTime()) {
    throw new MediaAnalyticsWindowError({
      message: "That window ends before it starts. Put since before until.",
      detail: `since ${since.toISOString()} is not before until ${until.toISOString()}`,
    });
  }
  return { since, until };
}

/**
 * Hold a window to one dataset's limits, read from the account's own settings rather than assumed. The
 * refusal names the cap in days, so a caller can pick a window that works.
 */
function checkWindow(window: DeliveryWindow, limits: DatasetLimits, measured: Measured, now: Date): void {
  const reach = (now.getTime() - window.since.getTime()) / 1000;
  if (reach > limits.notOlderThan) {
    const maxDays = days(limits.notOlderThan);
    throw new MediaAnalyticsWindowError({
      message: `That window starts ${days(reach)} days ago. Cloudflare keeps ${measured.label} for ${maxDays} days.`,
      params: { maxDays, dataset: measured.dataset },
      detail: `${measured.dataset} notOlderThan ${limits.notOlderThan}s; window reaches ${Math.round(reach)}s`,
    });
  }
  const span = (window.until.getTime() - window.since.getTime()) / 1000;
  if (span > limits.maxDuration) {
    const maxDays = days(limits.maxDuration);
    throw new MediaAnalyticsWindowError({
      message: `That window spans ${days(span)} days. Cloudflare answers at most ${maxDays} days of ${measured.label} at once.`,
      params: { maxDays, dataset: measured.dataset },
      detail: `${measured.dataset} maxDuration ${limits.maxDuration}s; window spans ${Math.round(span)}s`,
    });
  }
}

/** Most first, then by name, so the order is stable between two reads of the same numbers. */
function byValue<T extends { name: string }>(value: (item: T) => number) {
  return (a: T, b: T) => value(b) - value(a) || a.name.localeCompare(b.name);
}

/** The sentence for a type stored in R2. */
function storedInR2(type: "Videos" | "Images", product: string, key: string) {
  return {
    state: "unavailable" as const,
    reason: "stored-in-r2" as const,
    message: `${type} are stored in R2 (${key} in pithy.config.ts), so ${product} counts nothing for them.`,
  };
}

/**
 * Read what was served in the window, per asset.
 *
 * A type stored in R2 is named as unavailable and why — never zero, which would be a claim. A dataset
 * Cloudflare does not serve to this account is a refusal for the same reason: under a Customer Metadata
 * Boundary outside the US both datasets are absent, and "nothing was watched" is a different sentence
 * from "your metadata boundary does not carry this".
 */
export async function readDelivery(
  deps: DeliveryDeps,
  input: { since?: Date; until?: Date },
): Promise<MediaDeliveryResponse> {
  const now = deps.now();
  const window = resolveWindow(input, now);
  const measured = [
    ...(deps.config.video.store === "cf-stream" ? [VIDEO] : []),
    ...(deps.config.images.store === "cf-images" ? [IMAGES] : []),
  ];

  let source: DeliverySource | undefined;
  if (measured.length > 0) {
    source = await deps.source();
    const limits = await source.datasetLimits(measured.map((m) => m.dataset));
    for (const m of measured) {
      const dataset = limits[m.dataset];
      if (!dataset?.enabled) {
        throw new MediaAnalyticsUnavailableError({
          message: `Cloudflare does not serve ${m.label} to this account. Stream and Images analytics are US-only: under a Customer Metadata Boundary outside the US there are none to read.`,
          params: { dataset: m.dataset },
          detail: `${m.dataset} settings: ${dataset === undefined ? "absent" : "enabled: false"}`,
        });
      }
    }
    for (const m of measured) checkWindow(window, limits[m.dataset] as DatasetLimits, m, now);
  }

  let video: VideoDelivery = storedInR2("Videos", "Cloudflare Stream", "video.store");
  if (source && measured.includes(VIDEO)) {
    const assets = await deps.assets(VIDEO.type, VIDEO.backend);
    const minutes = await source.streamMinutesViewed({ ...window, uids: assets.map((a) => a.storageKey) });
    video = {
      state: "reported",
      assets: assets
        .map((a) => ({
          id: a.id,
          name: a.name,
          storageKey: a.storageKey,
          minutesViewed: minutes.get(a.storageKey) ?? 0,
        }))
        .sort(byValue((item) => item.minutesViewed)),
    };
  }

  let images: ImageDelivery = storedInR2("Images", "Cloudflare Images", "images.store");
  if (source && measured.includes(IMAGES)) {
    const assets = await deps.assets(IMAGES.type, IMAGES.backend);
    const requests = await source.imageRequests({ ...window, imageIds: assets.map((a) => a.storageKey) });
    images = {
      state: "reported",
      assets: assets
        .map((a) => ({ id: a.id, name: a.name, storageKey: a.storageKey, requests: requests.get(a.storageKey) ?? 0 }))
        .sort(byValue((item) => item.requests)),
    };
  }

  return { since: window.since.toISOString(), until: window.until.toISOString(), video, images };
}
