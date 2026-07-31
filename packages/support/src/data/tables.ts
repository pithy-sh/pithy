// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { SupportAttachment } from "./attachment";
import { SupportClassification } from "./classification";
import { SupportThreadFlag } from "./flag";
import { SupportMessage } from "./message";
import { SupportThread } from "./thread";

/**
 * The support tables. Keys are camelCase; `CamelCasePlugin` snake-cases them to the `pithy_support_*`
 * SQL, so query code in this package never types the prefix and never types an underscore.
 */

/** Conversations. `pithy_support_threads`. */
export const SUPPORT_THREADS_TABLE = "pithySupportThreads";
/** Messages, inbound and outbound. `pithy_support_messages`. */
export const SUPPORT_MESSAGES_TABLE = "pithySupportMessages";
/** Attachment metadata. `pithy_support_attachments`. */
export const SUPPORT_ATTACHMENTS_TABLE = "pithySupportAttachments";
/** Append-only classification history. `pithy_support_classifications`. */
export const SUPPORT_CLASSIFICATIONS_TABLE = "pithySupportClassifications";
/** Per-viewer read/snooze state. `pithy_support_thread_flags`. */
export const SUPPORT_FLAGS_TABLE = "pithySupportThreadFlags";

/**
 * The FTS5 full-text index. Not a Kysely table and deliberately not in {@link supportTables}: it is a
 * virtual table with no Zod schema and no rows of its own worth typing, reached through raw `sql`
 * from `store/search.ts` alone.
 *
 * Named in snake_case because nothing translates it — `CamelCasePlugin` rewrites identifiers Kysely
 * builds, and every statement touching this one is written by hand.
 */
export const SUPPORT_SEARCH_TABLE = "pithy_support_search";

/** The table map the capability contributes to the app database. */
export const supportTables = {
  [SUPPORT_THREADS_TABLE]: SupportThread,
  [SUPPORT_MESSAGES_TABLE]: SupportMessage,
  [SUPPORT_ATTACHMENTS_TABLE]: SupportAttachment,
  [SUPPORT_CLASSIFICATIONS_TABLE]: SupportClassification,
  [SUPPORT_FLAGS_TABLE]: SupportThreadFlag,
} satisfies Record<string, z.ZodObject>;

/** The support tables, as a type. */
export type SupportTables = typeof supportTables;

/** The typed Kysely view over the support tables. Carries `CamelCasePlugin`. */
export type SupportDatabase = Kysely<DatabaseSchema<SupportTables>>;

/** Build the support database from a `DB` binding. */
export function supportDatabase(d1: D1Database): SupportDatabase {
  return createDatabase(d1, supportTables) as unknown as SupportDatabase;
}
