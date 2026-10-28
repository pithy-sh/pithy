// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely, KyselyPlugin, QueryId } from "kysely";

/**
 * The same database, with `between` run after each of its first `times` reads and before the caller sees the rows: a
 * write that lands between a read and the write made from it.
 *
 * `between` receives the count of reads it has followed so far, from 0. It must write through another handle, since a
 * read it made through this one would be followed in turn.
 */
export function writeAfterRead<DB>(
  db: Kysely<DB>,
  between: (count: number) => Promise<void>,
  times = Number.POSITIVE_INFINITY,
): Kysely<DB> {
  const reads = new WeakSet<QueryId>();
  let count = 0;
  const plugin: KyselyPlugin = {
    transformQuery({ queryId, node }) {
      if (node.kind === "SelectQueryNode") reads.add(queryId);
      return node;
    },
    async transformResult({ queryId, result }) {
      if (reads.has(queryId) && count < times) await between(count++);
      return result;
    },
  };
  return db.withPlugin(plugin);
}
