// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The analytics datasets the kit reads, by their GraphQL names**, in a module of their own. A Worker
 * names a dataset to read its limits and to word a refusal, and importing the manager to learn a string
 * would put the Cloudflare SDK on every module that does (#731). Nothing here imports anything.
 */

/** Minutes of Stream video delivered, groupable by video `uid`. Account-level, US-only under a metadata boundary. */
export const STREAM_MINUTES = "streamMinutesViewedAdaptiveGroups";

/**
 * Hosted Images delivery requests, groupable by `imageId` — the id Cloudflare Images assigns at upload.
 *
 * Not `imagesRequestsAdaptiveGroups`: that dataset groups by time and nothing else, so it can only ever
 * answer an account total, which cannot be scoped to an environment. This one carries the image id,
 * found by schema introspection on 2026-10-17.
 */
export const IMAGE_REQUESTS = "imagesHostedRequestsAdaptiveGroups";

/**
 * Turnstile challenge events, groupable by `siteKey` and `eventType` (#731). Account-level, and served under
 * a US and an EU metadata boundary alike, so a boundary does not rule it out. Found by schema introspection
 * on 2026-10-18; Cloudflare marks it Beta.
 */
export const TURNSTILE_EVENTS = "turnstileAdaptiveGroups";

/** The datasets this manager queries. */
export type AnalyticsDataset = typeof STREAM_MINUTES | typeof IMAGE_REQUESTS | typeof TURNSTILE_EVENTS;
