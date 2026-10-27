// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { type ErasingPurgeContribution, exportRows, purgeBinding } from "@pithy-sh/core/src/capability/purge";
import { TestersEvent } from "../data/event";
import { TestersMember } from "../data/member";
import { TESTERS_EVENTS_TABLE, TESTERS_MEMBERS_TABLE, testersDatabase } from "../data/tables";

/**
 * What erasing one person means for `@pithy-sh/testers` (#814): their membership of every cohort, and every event
 * recorded against it — invited, accepted, nudged, lapsed — and what exporting them hands back.
 *
 * **Found by address, because that is the join.** A member stores no `userId`: the lowercased address is the join
 * key to `@pithy-sh/auth` (`../data/member.ts`). So the step reads the account's address (`PurgeContext.address`)
 * and erases the memberships held under it. With no address to read there is nothing to find, and the step
 * succeeds having done nothing.
 *
 * **A cohort's snapshots stay.** They are counts — roster size, how many opted in — and name nobody.
 *
 * **One transaction**, and **idempotent**: a second run finds no membership and deletes nothing.
 */

/** The one sentence the purge records with this step. */
export const TESTERS_PURGE_SUMMARY =
  "Deletes the user's membership of every tester cohort, found by their address, and every event recorded against it. Cohort counts stay.";

/** The account's address in `normalizeAddress`'s form — the form a member's address is stored in — or none. */
function normalizedAddress(address: string | null | undefined): string | undefined {
  return address ? normalizeAddress(address) : undefined;
}

/** The user contribution `testers()` declares. */
export function testersUserPurge(database = "DB"): ErasingPurgeContribution {
  const open = (env: Record<string, unknown>) => {
    const d1 = purgeBinding<D1Database>(env, database, "testers");
    return { d1, db: testersDatabase(d1) };
  };
  return {
    subject: "user",
    summary: TESTERS_PURGE_SUMMARY,
    erase: async (context) => {
      const address = normalizedAddress(await context.address?.());
      if (!address) return;
      const { d1, db } = open(context.env);
      const members = db.selectFrom(TESTERS_MEMBERS_TABLE).select("id").where("email", "=", address);
      const statements = [
        db.deleteFrom(TESTERS_EVENTS_TABLE).where("memberId", "in", members).compile(),
        db.deleteFrom(TESTERS_MEMBERS_TABLE).where("email", "=", address).compile(),
      ];
      await d1.batch(
        statements.map((compiled) => d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]))),
      );
    },
    export: async (context) => {
      const address = normalizedAddress(await context.address?.());
      if (!address) return { memberships: [], events: [] };
      const { db } = open(context.env);
      const [members, events] = await Promise.all([
        db.selectFrom(TESTERS_MEMBERS_TABLE).selectAll().where("email", "=", address).orderBy("createdAt").execute(),
        db
          .selectFrom(TESTERS_EVENTS_TABLE)
          .selectAll()
          .where("memberId", "in", db.selectFrom(TESTERS_MEMBERS_TABLE).select("id").where("email", "=", address))
          .orderBy("occurredAt")
          .orderBy("id")
          .execute(),
      ]);
      return {
        // Without the opt-in token: it is the credential an opt-in link carries, and an export is never one.
        memberships: exportRows(
          members.map((row) => {
            const { optInToken: _token, ...member } = TestersMember.parse(row);
            return member;
          }),
        ),
        events: exportRows(events.map((row) => TestersEvent.parse(row))),
      };
    },
  };
}
