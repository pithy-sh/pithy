// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import {
  PRESENCE_TICKET_KEY_SECRET,
  type PresenceDeclaration,
  type PresenceSessionGate,
} from "@pithy-sh/core/src/presence/declaration";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import type { Context } from "hono";
import type { SupportWiring } from "../capability";
import type { SupportStaffConfig } from "../config/config";
import { SUPPORT_THREADS_READ_SCOPE } from "../http/scopes";
import { resolveSubmitterAccount } from "../link/sender";
import { supportPresenceRegistry } from "../secret/registry";
import { staffMay } from "../staff/staff";

/**
 * Who else has a support thread open (#816) — support's one room kind on core's presence seam (#815).
 *
 * Anyone who may read a thread may see who else has it open, so the room joins with the scope that already
 * reads it, `support:threads:read`, and adds none of its own. A management client mints its ticket at
 * `POST /control-plane/presence/tickets`; a signed-in user of the app mints one at
 * `POST {basePath}/presence/tickets` when `support({ staff })` names a read power their role holds. The room
 * holds nothing but who is here and writes nothing anywhere.
 */

/** The room kind: one room per thread, keyed by the thread's id. */
export const SUPPORT_THREAD_ROOM = "support.thread";

/**
 * What a participant may announce. `viewing` first, because the first is what a participant joins as;
 * `replying` is announced by the client when its reply form opens, and cleared when it closes.
 */
export const SUPPORT_THREAD_ACTIVITIES = ["viewing", "replying"] as const;

/** The account name a staff participant joins under, or null when it cannot be read. */
export type StaffName = (c: Context<PithyHonoEnv>, userId: string) => Promise<{ name?: string } | null>;

/**
 * The session gate: the read power in the organization this request acts for, the same question the staff
 * routes ask. Admits under the account's own name; with none to read, core falls back to the user id.
 */
export function staffPresenceGate(staff: SupportStaffConfig, nameOf: StaffName): PresenceSessionGate {
  return async (c) => {
    const userId = c.var.auth?.userId;
    if (!userId) return null;
    if (!staffMay(await c.var.actingOrganization(), staff, "readPower")) return null;
    const account = await nameOf(c, userId);
    return account?.name ? { name: account.name } : {};
  };
}

/**
 * The ticket signing keys, read through `@pithy-sh/secrets` per request — the current version signs and
 * every version still honored verifies, so a rotation never strands a socket mid-handshake.
 */
async function ticketKeys(env: Record<string, unknown>): Promise<string[]> {
  const secrets = await sharedSecretsStore(env as unknown as SecretsStoreEnv, supportPresenceRegistry);
  const { currentVersion, versions } = secrets.getVersions(PRESENCE_TICKET_KEY_SECRET);
  const current = versions[currentVersion];
  return [
    ...(current === undefined ? [] : [current]),
    ...Object.entries(versions)
      .filter(([version]) => version !== currentVersion)
      .map(([, value]) => value),
  ];
}

/** Support's presence declaration, built from its resolved mount and staff config. */
export function supportPresence(basePath: string, wiring: SupportWiring): PresenceDeclaration {
  const staff = wiring.config.staff;
  return {
    basePath,
    ticketKey: ticketKeys,
    rooms: [
      {
        kind: SUPPORT_THREAD_ROOM,
        scope: SUPPORT_THREADS_READ_SCOPE,
        activities: SUPPORT_THREAD_ACTIVITIES,
        ...(staff
          ? {
              session: staffPresenceGate(staff, async (c, userId) => {
                const d1 = (c.env as unknown as { DB?: Parameters<typeof resolveSubmitterAccount>[0] }).DB;
                return d1 ? resolveSubmitterAccount(d1, userId, wiring.peers) : null;
              }),
            }
          : {}),
      },
    ],
  };
}
