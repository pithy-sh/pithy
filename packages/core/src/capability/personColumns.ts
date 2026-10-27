// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import type { DatabaseSpecMap } from "../data/databases";

/**
 * **Every capability that holds rows about a person answers for them** — erases them on a purge, or keeps them and
 * says why, and in both cases exports them (#814). This is the check that holds a capability to it, from its own
 * schema rather than from a list somebody maintains.
 *
 * A table carries a row about a person when a column names one: an id (`userId`, `ownerId`, `subjectId`, `actorId`,
 * any `…UserId`, the two sides of an invite or a friendship) or an address (`email`, `recipient`, any `…Address`).
 * A capability whose schema carries one must declare a `user` purge contribution with an `export`. `retain` requires
 * one already; an erasing contribution may omit it, and for an adopter's own capability that is the honest
 * `not_exported` — but no kit capability may.
 *
 * Over-reaching is cheap here and under-reaching is the defect: a column that names an operator or a sender rather
 * than the person still costs only a contribution that finds nothing, while a person column the rule missed is rows
 * an access request never answers for.
 */

/** Column names that name a person outright. */
const PERSON_COLUMNS: ReadonlySet<string> = new Set([
  "userId",
  "ownerId",
  "subjectId",
  "actorId",
  "inviterId",
  "inviteeId",
  "userA",
  "userB",
  "email",
  "recipient",
]);

/** Whether a column, by its camelCase name, names a person: an id of one, or an address. */
export function isPersonColumn(column: string): boolean {
  return PERSON_COLUMNS.has(column) || column.endsWith("UserId") || column.endsWith("Address");
}

/** What the check reads off a capability — its name, its tables and its purge contributions. */
export interface PersonRowsSubject {
  readonly name: string;
  readonly databases?: DatabaseSpecMap;
  readonly purge?: readonly { readonly subject: string; readonly export?: unknown }[];
}

/** One capability that holds rows about a person and does not answer for them. */
export interface PersonRowGap {
  /** The capability. */
  readonly capability: string;
  /** Its person columns, as `table.column`. */
  readonly columns: readonly string[];
  /** `no_contribution` — no `user` purge contribution at all; `no_export` — one that does not export. */
  readonly gap: "no_contribution" | "no_export";
}

/** Every person column in a capability's tables, as `table.column`, in declaration order. */
export function personColumnsOf(capability: PersonRowsSubject): string[] {
  const found: string[] = [];
  for (const spec of Object.values(capability.databases ?? {})) {
    for (const [table, schema] of Object.entries(spec.tables)) {
      const shape = (schema as z.ZodObject).shape ?? {};
      for (const column of Object.keys(shape)) if (isPersonColumn(column)) found.push(`${table}.${column}`);
    }
  }
  return found;
}

/** Every capability among `capabilities` that holds rows about a person and does not answer for them. */
export function personRowGaps(capabilities: readonly PersonRowsSubject[]): PersonRowGap[] {
  const gaps: PersonRowGap[] = [];
  for (const capability of capabilities) {
    const columns = personColumnsOf(capability);
    if (columns.length === 0) continue;
    const contribution = capability.purge?.find((candidate) => candidate.subject === "user");
    if (!contribution) gaps.push({ capability: capability.name, columns, gap: "no_contribution" });
    else if (typeof contribution.export !== "function")
      gaps.push({ capability: capability.name, columns, gap: "no_export" });
  }
  return gaps;
}
