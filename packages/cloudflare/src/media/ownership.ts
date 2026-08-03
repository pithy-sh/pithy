// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareNotConfiguredError } from "../client/errors";

/**
 * The ownership stamp on every Cloudflare Images and Stream asset Pithy creates.
 *
 * Every other resource this toolset provisions is isolated by its **name** —
 * `<project>-<env>-<thing>`, because those namespaces are flat and account-wide (CLAUDE.md
 * §Resource naming). Images and Stream cannot use that lever: their stores are just as flat and
 * account-wide, but an asset is keyed by a **Cloudflare-minted id**, not by a name we choose. So
 * metadata is the only place ownership can live, and without it two projects' assets in one account
 * are indistinguishable — you cannot tell which app owns an asset, cannot sweep one app's assets at
 * teardown, and `pithy doctor` is blind to them.
 *
 * The **same two keys** are used for both stores (Images `metadata`, Stream `meta`), so one query
 * answers "what does this project own" across them rather than two dialects answering half each.
 * Nothing else is imposed: a caller's own metadata rides along untouched — but it can never displace
 * the reserved keys, which are merged last on purpose.
 */

/** The metadata key naming the owning project — the root `pithy.config.ts` `name`. */
export const ASSET_PROJECT_KEY = "pithyProject";

/** The metadata key naming the owning environment (`dev` | `staging` | `production`). */
export const ASSET_ENV_KEY = "pithyEnv";

/** Who owns an asset: the project that created it, in the environment that created it. */
export interface AssetOwner {
  /**
   * The project name — the root `pithy.config.ts` `name`, resolved by `requireProjectName` and never
   * guessed. It is the segment every sweep, listing, and teardown filters on.
   */
  project: string;
  /** The environment the asset was created in (`dev` | `staging` | `production`). */
  env: string;
}

/**
 * Merge the ownership stamp over a caller's metadata bag.
 *
 * Ownership is applied **last**, so a caller-supplied `pithyProject`/`pithyEnv` cannot displace the
 * real one — a fixture or a client-supplied bag claiming another project's assets would defeat the
 * whole point of the stamp. A blank project or environment is refused rather than written: an asset
 * stamped with an empty string reads as owned and still sweeps to nothing.
 */
export function withAssetOwnership(owner: AssetOwner, metadata?: Record<string, string>): Record<string, string> {
  const project = owner.project.trim();
  const env = owner.env.trim();
  if (!project || !env) {
    throw new CloudflareNotConfiguredError({
      message: "A Cloudflare Images or Stream asset cannot be created without an owner.",
      action: "Pass the project (requireProjectName) and the environment to the uploader.",
      detail: `asset owner is incomplete: project="${owner.project}", env="${owner.env}"`,
    });
  }
  return { ...metadata, [ASSET_PROJECT_KEY]: project, [ASSET_ENV_KEY]: env };
}
