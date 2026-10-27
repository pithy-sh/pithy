// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { CompiledQuery } from "kysely";
import { type RatingDatabase, ratingBinding } from "./tables";

/** A Kysely query that can be compiled — every builder is one. */
export interface Compilable {
  compile(): CompiledQuery;
}

/**
 * Run several queries as one `DB.batch`, which D1 runs as a single transaction: all of them land or none
 * does. Kysely builds each statement, so the `CamelCasePlugin` still names every column; only the batch
 * itself is D1-native, as in `@pithy-sh/ledger`.
 */
export async function runBatch(db: RatingDatabase, queries: readonly Compilable[]): Promise<void> {
  const d1 = ratingBinding(db);
  if (!d1) {
    throw new InternalError({
      message: "The rating store could not write atomically.",
      detail: "A rating write needs a database built by ratingDatabase(d1), which knows its D1 binding.",
    });
  }
  const statements: D1PreparedStatement[] = queries.map((query) => {
    const compiled = query.compile();
    return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
  });
  await d1.batch(statements);
}

/**
 * Whether a D1 error is a UNIQUE violation — how a batch that lost an idempotency race is told apart.
 *
 * SQLite's wording is the only signal D1 gives, so it is matched on the error, its string form, and every
 * `cause` beneath it: a layer that wraps the D1 error must not turn a lost race into a 500. The chain is
 * bounded, so a cyclic `cause` cannot spin.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    const message = (current as { message?: unknown }).message ?? current;
    if (/UNIQUE constraint failed/i.test(String(message))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
