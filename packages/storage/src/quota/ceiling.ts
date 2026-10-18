// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { meterLimit } from "@pithy-sh/core/src/entitlement/allowance";
import type { Context } from "hono";
import type { StorageConfig } from "../config/config";

/**
 * The per-owner byte ceiling for one request: the `storageBytes` quota where an entitlement provider enforces
 * that meter, the configured `quota.bytesPerOwner` where it does not.
 *
 * **Configured behavior is the fallback, never replaced by surprise.** With no provider composed, or one that
 * leaves `storageBytes` advisory, this is `bytesPerOwner` exactly — which is what every project had before
 * plans could say how much a customer may store. Enforced, it is the caller's effective quota: their plan's
 * number, a number pinned for them, or `null` — unlimited — for an `unrestricted` subject.
 *
 * A provider whose read fails refuses the write rather than serving it unbounded: `meterLimit` throws, and
 * the request fails with it. Over-counting is recoverable; under-counting is not.
 */
export async function storageCeiling(c: Context<PithyHonoEnv>, config: StorageConfig): Promise<number | null> {
  const ceiling = await meterLimit(c, "storageBytes");
  return ceiling.enforced ? ceiling.limit : config.quota.bytesPerOwner;
}
