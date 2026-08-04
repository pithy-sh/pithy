// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { TypedKv } from "../../kv/kv";
import type { KvNamespaceSpecMap } from "../../kv/namespaces";
import { CONTROL_PLANE_JTI_TTL_SECONDS } from "../token/claims";
import type { ReplayGuard } from "./guard";

/**
 * The KV-backed {@link ReplayGuard} — still selectable, no longer the default.
 *
 * See `./guard.ts` for what the guard is for and why D1 now holds the default. The part that belongs
 * here is the caveat that is a property of *this* store and not of the seam:
 *
 * **Workers KV has no compare-and-set and is eventually consistent across colocations.** A `put` in one
 * PoP is not immediately visible in another, so two copies of one token presented in two locations
 * inside the propagation window can both read a miss and both claim. Read-then-write is the strongest
 * claim KV offers; it is best-effort, not an atomic single-use gate.
 *
 * Three things bound the exposure for an adopter who chooses it anyway.
 *
 * 1. **The window is KV's propagation delay** — seconds, and independent of the 60-second token. The
 *    write is issued the moment the first call lands; once it has converged the jti is spent for a full
 *    {@link CONTROL_PLANE_JTI_TTL_SECONDS}, which deliberately outlives the token that carried it. So
 *    there is no window at the end of the token's life, only at the very start of it.
 * 2. **The token is not a general capability.** It is bound to one connection, one scope, one request
 *    body digest, and that expiry. What can survive the window is a replay of *the exact same call* —
 *    not a forged one, not a broader one, not a later one.
 * 3. **`d1ReplayGuard` is one config key away**, and closes the race outright. Choosing this one is
 *    choosing to skip a D1 write on an administrator-paced path, with the race as the stated price.
 */

/**
 * The KV binding the seam's replay set lives in.
 *
 * **Not Cloudflare's control plane.** That is the outbound provisioning REST API this project reaches
 * through `@pithy-sh/cloudflare`. This is the inbound, adopter-authenticated admin seam, and it owns
 * its own namespace rather than sharing `SESSIONS` — a junk-drawer KV would put user sessions and
 * management-token receipts behind one binding, and they have nothing to do with each other.
 */
export const CONTROL_PLANE_KV_BINDING = "CONTROL_PLANE";

/**
 * The fixed first key segment for everything the seam stores in KV.
 *
 * One word, no hyphen: `assertValidConfig` rejects a prefix containing the key separator, and the
 * namespace tokens across this capability (migration namespace, table prefix, error domain) are all
 * the single word `controlplane` for the same family of reasons. The `jti` segment below is what makes
 * the physical key read `controlplane:jti:<id>` — a scope segment in the key, not in the prefix, so a
 * second kind of seam entry can join the namespace without colliding.
 */
export const CONTROL_PLANE_KV_PREFIX = "controlplane";

/** A spent token's receipt: which connection burned it, and when. */
export const SeenJti = z
  .object({
    connectionId: z
      .string()
      .min(1)
      .describe(
        "The connection whose token claimed this jti. Recorded for forensics only — a replay is refused whatever connection presents it, because the jti alone is the key.",
      ),
    seenAt: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "When the jti was claimed, as a ms-epoch number. A plain number rather than a date codec: nothing decodes this back into app types, and it exists to make a raw KV dump readable during an incident.",
      ),
  })
  .describe(
    "The receipt written when a control-plane token is spent. Its presence is the whole signal; the fields are for the incident, not the decision.",
  );
export type SeenJti = z.infer<typeof SeenJti>;

/** The key for one receipt. Physical key: `controlplane:jti:<jti>`. */
export const SeenJtiKey = z
  .object({
    scope: z
      .literal("jti")
      .describe(
        "The fixed second key segment, naming what kind of entry this is. Carried in the key rather than the prefix so the namespace can hold another kind of seam entry later without a migration.",
      ),
    jti: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "The token's unique id, minted by the management client. Bounded because it arrives from a caller and becomes a KV key — an unbounded id would be an unbounded write.",
      ),
  })
  .describe("The KV key identifying one spent token: the `jti` scope segment and the token id itself.");
export type SeenJtiKey = z.infer<typeof SeenJtiKey>;

/**
 * The KV namespaces the control-plane capability registers, served on `c.var.kv.controlplane.jtis`.
 *
 * The TTL is the store's, not the caller's: an entry that expired while the token that spent it was
 * still valid would silently reopen the replay window, so it is declared once here and every write
 * inherits it.
 *
 * **A function of the config, not a constant.** It used to be a module-level literal pinned to
 * {@link CONTROL_PLANE_JTI_TTL_SECONDS}, which made `jtiTtlSeconds` dead config: an adopter who
 * lengthened `maxTokenLifetimeSeconds` and lengthened the replay memory to match — the pairing the
 * config's own cross-field check tells them to make — still got a 180-second store, and their tokens
 * outlived the memory of them. The one setting that governs this store now actually reaches it.
 */
export function controlPlaneKvNamespaces(jtiTtlSeconds: number = CONTROL_PLANE_JTI_TTL_SECONDS) {
  return {
    controlplane: {
      binding: CONTROL_PLANE_KV_BINDING,
      stores: {
        jtis: {
          prefix: CONTROL_PLANE_KV_PREFIX,
          key: SeenJtiKey,
          value: SeenJti,
          ttlSeconds: jtiTtlSeconds,
        },
      },
    },
  } satisfies KvNamespaceSpecMap;
}

/** The shape {@link controlPlaneKvNamespaces} produces — what `c.var.kv` is narrowed to. */
export type ControlPlaneKvNamespaces = ReturnType<typeof controlPlaneKvNamespaces>;

/**
 * A {@link ReplayGuard} over a typed KV store — the shipped implementation.
 *
 * Read-then-write, because KV offers nothing better. A stored receipt that fails validation throws
 * rather than resolving, which fails closed: a poisoned entry denies the call instead of admitting it.
 */
export function kvReplayGuard<M extends z.ZodType>(store: TypedKv<typeof SeenJti, typeof SeenJtiKey, M>): ReplayGuard {
  return {
    async claim(jti: string, connectionId: string): Promise<boolean> {
      const key = { scope: "jti", jti } as const;
      if ((await store.get(key)) !== null) return false;
      await store.put(key, { connectionId, seenAt: Date.now() });
      return true;
    },
  };
}
