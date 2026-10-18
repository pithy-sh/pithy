// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { meterLimit } from "@pithy-sh/core/src/entitlement/allowance";
import type { Context } from "hono";
import type { StorageConfig } from "../config/config";

/** The byte ceiling one request's writes are held to, and whose bytes it is the whole of. */
export interface StorageCeiling {
  /** The ceiling in bytes. Null is unlimited. */
  limitBytes: number | null;
  /**
   * The organization the ceiling covers, or null when it is the caller's own. Set, every byte stored for
   * that organization counts against it, whoever uploaded it — an organization's plan is the organization's.
   */
  tenant: string | null;
}

/**
 * The byte ceiling for one request: the `storageBytes` quota where an entitlement provider enforces that
 * meter, the configured `quota.bytesPerOwner` where it does not.
 *
 * **Configured behavior is the fallback, never replaced by surprise.** With no provider composed, or one that
 * leaves `storageBytes` advisory, this is `bytesPerOwner` exactly, counted per owner — which is what every
 * project had before plans could say how much a customer may store. Enforced, it is the billing subject's
 * effective quota: their plan's number, a number pinned for them, or `null` — unlimited — for an
 * `unrestricted` subject. Under organization billing that subject is the organization, and so is the sum.
 *
 * A provider whose read fails refuses the write rather than serving it unbounded: `meterLimit` throws, and
 * the request fails with it. Over-counting is recoverable; under-counting is not.
 */
export async function storageCeiling(c: Context<PithyHonoEnv>, config: StorageConfig): Promise<StorageCeiling> {
  const ceiling = await meterLimit(c, "storageBytes");
  return ceiling.enforced
    ? { limitBytes: ceiling.limit, tenant: ceiling.tenant }
    : { limitBytes: config.quota.bytesPerOwner, tenant: null };
}
