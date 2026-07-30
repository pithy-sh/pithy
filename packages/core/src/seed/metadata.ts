// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The standard Cloudflare-asset metadata convention.
 *
 * Every write to a shared Images/Stream store (seeded assets are the first consumer, but the
 * convention is account-wide) stamps a small, stable metadata block so an asset can be attributed
 * and scoped without a separate lookup — most importantly to the environment that created it, so a
 * staging teardown never touches a production asset. App-defined fields (e.g. `userId`) merge on
 * top; the standard keys always win, so a caller's `extra` can never overwrite `pithyEnv`.
 */

/** The metadata key carrying the environment an asset was created in — the scoping anchor. */
export const PITHY_ENV_METADATA_KEY = "pithyEnv";

/** The metadata keys Pithy sets on every shared-asset write. Kept stable and documented. */
export const STANDARD_ASSET_METADATA_KEYS: readonly string[] = [PITHY_ENV_METADATA_KEY];

/**
 * Build the metadata block for a shared-asset upload: the standard keys (at minimum
 * `{ pithyEnv: env }`) merged over any app-defined `extra`. The standard keys are applied last, so
 * they always win — `extra` can add fields but never override the scoping anchor.
 */
export function buildAssetMetadata(env: string, extra?: Record<string, string>): Record<string, string> {
  return { ...extra, [PITHY_ENV_METADATA_KEY]: env };
}
