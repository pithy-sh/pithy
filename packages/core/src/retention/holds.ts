// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type HoldSubjectType, LegalHold } from "../controlPlane/data/hold";
import {
  CONTROL_PLANE_HOLDS_TABLE,
  type ControlPlaneDatabase,
  controlPlaneDatabase,
} from "../controlPlane/data/tables";
import { SQLiteDate } from "../data/codecs";
import { ConflictError, NotFoundError } from "../error/pithyError";

/**
 * **Legal holds: placing, releasing and reading them, and the one question every purge asks.**
 *
 * The holds live in the control plane's table in the app database, `DB`. A capability that erases — auth's purge,
 * organization's purge, audit's prune, auth's inactivity pass — cannot import the control plane, so it asks through
 * {@link legalHolds}, over the env its Workflow was handed, before every step that would touch a subject.
 *
 * **A hold that cannot be read is not an absent hold.** Only one answer reads as "nothing is held" without a row: a
 * database that has no hold table, because no control plane ever migrated it, so nothing could have placed one. Any
 * other failure throws, and the step that asked fails and retries rather than erasing past a hold it could not see.
 */

/** Who places or releases a hold: the management client's own user id. */
export interface HoldActor {
  readonly subject: string;
}

/** Place a hold. Holds stack: a second hold on one subject is its own row, released on its own. */
export async function placeHold(
  db: ControlPlaneDatabase,
  input: { subjectType: HoldSubjectType; subjectId: string | null; reason: string; actor: HoldActor; at: Date },
): Promise<LegalHold> {
  const hold: LegalHold = {
    id: crypto.randomUUID(),
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    reason: input.reason,
    placedBy: input.actor.subject,
    placedAt: input.at,
    state: "active",
    releasedAt: null,
    releasedBy: null,
    releaseReason: null,
  };
  await db.insertInto(CONTROL_PLANE_HOLDS_TABLE).values(LegalHold.encode(hold)).execute();
  return hold;
}

/**
 * Release a hold, with a reason. A hold already released is a conflict, never a second release: the row keeps the
 * first one's who and why. An unknown id is a 404.
 */
export async function releaseHold(
  db: ControlPlaneDatabase,
  input: { id: string; reason: string; actor: HoldActor; at: Date },
): Promise<LegalHold> {
  const existing = await readHold(db, input.id);
  if (!existing) {
    throw new NotFoundError({ message: "No hold has that id.", detail: `hold ${input.id} not found` });
  }
  const result = await db
    .updateTable(CONTROL_PLANE_HOLDS_TABLE)
    .set({
      state: "released",
      releasedAt: SQLiteDate.encode(input.at),
      releasedBy: input.actor.subject,
      releaseReason: input.reason,
    })
    .where("id", "=", input.id)
    .where("state", "=", "active")
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) {
    throw new ConflictError({
      message: "That hold is already released.",
      detail: `hold ${input.id} was released before this call`,
    });
  }
  return {
    ...existing,
    state: "released",
    releasedAt: input.at,
    releasedBy: input.actor.subject,
    releaseReason: input.reason,
  };
}

/** One hold by id, or null. */
export async function readHold(db: ControlPlaneDatabase, id: string): Promise<LegalHold | null> {
  const row = await db.selectFrom(CONTROL_PLANE_HOLDS_TABLE).selectAll().where("id", "=", id).executeTakeFirst();
  return row ? LegalHold.parse(row) : null;
}

/** Every hold, active first, newest first within each, at most `limit`. */
export async function listHolds(
  db: ControlPlaneDatabase,
  options: { state?: "active" | "released"; limit: number },
): Promise<LegalHold[]> {
  let query = db
    .selectFrom(CONTROL_PLANE_HOLDS_TABLE)
    .selectAll()
    .orderBy("state", "asc")
    .orderBy("placedAt", "desc")
    .orderBy("id", "asc")
    .limit(options.limit);
  if (options.state) query = query.where("state", "=", options.state);
  return (await query.execute()).map((row) => LegalHold.parse(row));
}

/** How many holds stand. What the manifest carries. */
export async function countActiveHolds(db: ControlPlaneDatabase): Promise<number> {
  const row = await db
    .selectFrom(CONTROL_PLANE_HOLDS_TABLE)
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("state", "=", "active")
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** The question every purge, prune and inactivity pass asks before it touches a subject. */
export interface LegalHolds {
  /** Whether an active hold stands on this subject. A `null` id is the untenanted audit trail. */
  held(subjectType: HoldSubjectType, subjectId: string | null): Promise<boolean>;
}

/** The app database the control plane keeps its holds in. Fixed, as the seam's own binding is. */
export const HOLDS_BINDING = "DB";

/** Whether a D1 failure is the hold table not existing — a database no control plane ever migrated. */
function noHoldTable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return /no such table/i.test(text) && /pithy_controlplane_holds/i.test(text);
}

/** The holds over one env, read from {@link HOLDS_BINDING}. See the file header for what an unreadable read does. */
export function legalHolds(env: Record<string, unknown>): LegalHolds {
  const binding = env[HOLDS_BINDING];
  // No app database at all is a Worker no control plane could ever have placed a hold through.
  if (typeof binding !== "object" || binding === null) return { held: async () => false };
  const db = controlPlaneDatabase(binding as D1Database);
  return {
    held: async (subjectType, subjectId) => {
      try {
        let query = db
          .selectFrom(CONTROL_PLANE_HOLDS_TABLE)
          .select("id")
          .where("state", "=", "active")
          .where("subjectType", "=", subjectType)
          .limit(1);
        query = subjectId === null ? query.where("subjectId", "is", null) : query.where("subjectId", "=", subjectId);
        return (await query.execute()).length > 0;
      } catch (error) {
        if (noHoldTable(error)) return false;
        throw error;
      }
    },
  };
}

/**
 * How many holds stand in this env's app database — zero where no control plane ever migrated it, since nothing
 * could have placed one there. Any other failure throws, and the manifest reports the summary unavailable.
 */
export async function standingHolds(env: Record<string, unknown>): Promise<number> {
  const binding = env[HOLDS_BINDING];
  if (typeof binding !== "object" || binding === null) return 0;
  try {
    return await countActiveHolds(controlPlaneDatabase(binding as D1Database));
  } catch (error) {
    if (noHoldTable(error)) return 0;
    throw error;
  }
}
