// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { TestersCohort } from "./cohort";
import { TestersEvent } from "./event";
import { TestersMember } from "./member";
import { TestersCohortSnapshot } from "./snapshot";

/** The cohort itself. `CamelCasePlugin` snake-cases it to `pithy_testers_cohorts`. */
export const TESTERS_COHORTS_TABLE = "pithyTestersCohorts";
/** The roster projection. → `pithy_testers_members`. */
export const TESTERS_MEMBERS_TABLE = "pithyTestersMembers";
/** The append-only source of truth the streak is replayed from. → `pithy_testers_events`. */
export const TESTERS_EVENTS_TABLE = "pithyTestersEvents";
/** One row per cohort per UTC day — the chartable trend. → `pithy_testers_cohort_snapshots`. */
export const TESTERS_SNAPSHOTS_TABLE = "pithyTestersCohortSnapshots";

/** The testers tables map. All four are always present — none is behind a config flag. */
export function testersTables(): Record<string, z.ZodObject> {
  return {
    [TESTERS_COHORTS_TABLE]: TestersCohort,
    [TESTERS_MEMBERS_TABLE]: TestersMember,
    [TESTERS_EVENTS_TABLE]: TestersEvent,
    [TESTERS_SNAPSHOTS_TABLE]: TestersCohortSnapshot,
  };
}

/** The typed Kysely database over the testers tables. */
export type TestersTables = {
  [TESTERS_COHORTS_TABLE]: typeof TestersCohort;
  [TESTERS_MEMBERS_TABLE]: typeof TestersMember;
  [TESTERS_EVENTS_TABLE]: typeof TestersEvent;
  [TESTERS_SNAPSHOTS_TABLE]: typeof TestersCohortSnapshot;
};
export type TestersDatabase = Kysely<DatabaseSchema<TestersTables>>;

/** Build the testers database from a D1 binding, with `CamelCasePlugin` installed. */
export function testersDatabase(d1: D1Database): TestersDatabase {
  return createDatabase(d1, {
    [TESTERS_COHORTS_TABLE]: TestersCohort,
    [TESTERS_MEMBERS_TABLE]: TestersMember,
    [TESTERS_EVENTS_TABLE]: TestersEvent,
    [TESTERS_SNAPSHOTS_TABLE]: TestersCohortSnapshot,
  }) as unknown as TestersDatabase;
}
