// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/** One foreign key, as `PRAGMA foreign_key_list` reports it: `table` holds a column that references `references`. */
export interface ForeignKey {
  table: string;
  references: string;
  /** What deleting a referenced row does to `table`: `CASCADE`, `SET NULL`, `SET DEFAULT`, `RESTRICT` or `NO ACTION`. */
  onDelete: string;
}

/**
 * The order to drop `tables` in, so that no drop meets a table already gone.
 *
 * With foreign keys on, dropping a table deletes its rows first. A key that cascades deletes the referencing
 * rows with them, which looks up every table the referencing table references and cascades on from there.
 * A set null or set default key only rewrites the referencing column, which looks up the table being dropped
 * and nothing past it. So a table is dropped before every table it references, and a self-reference is no
 * constraint. Tables that reference each other in a cycle have no such order; they are ordered so that no
 * cascade from a drop reaches a table that still names a dropped one, and refused when no order does.
 *
 * Names match as SQLite matches them, ignoring ASCII case, and the order names each table as `tables` does.
 *
 * The caller runs the drops in one batch under `PRAGMA defer_foreign_keys = on`, which is what lets the
 * rows of a cycle go: each table's rows still reference the next table's until both are gone.
 */
export function dropOrder(tables: readonly string[], foreignKeys: readonly ForeignKey[]): string[] {
  const listed = new Map(tables.map((table) => [foldCase(table), table]));
  const keys = foreignKeys.flatMap((key) => {
    const table = listed.get(foldCase(key.table));
    const references = listed.get(foldCase(key.references));
    return table !== undefined && references !== undefined ? [{ ...key, table, references }] : [];
  });
  const position = new Map(tables.map((table, index) => [table, index]));
  const listedOrder = (a: string, b: string) => (position.get(a) ?? 0) - (position.get(b) ?? 0);
  const pending = components(tables, keys)
    .map((component) => component.sort(listedOrder))
    .sort((a, b) => listedOrder(a[0] ?? "", b[0] ?? ""));
  const dropped = new Set<string>();
  const order: string[] = [];
  while (pending.length > 0) {
    // Components form no cycle among themselves, so one always has no referrer left outside it.
    const ready = pending.findIndex((component) =>
      keys.every(
        (key) => !component.includes(key.references) || component.includes(key.table) || dropped.has(key.table),
      ),
    );
    const [component = []] = pending.splice(ready, 1);
    const members = component.length === 1 ? component : orderCycle(component, keys);
    for (const table of members) dropped.add(table);
    order.push(...members);
  }
  return order;
}

/** The strongly connected components of the reference graph: each cycle together, every other table alone. */
function components(tables: readonly string[], keys: readonly ForeignKey[]): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (table: string): void => {
    const own = index.size;
    index.set(table, own);
    low.set(table, own);
    stack.push(table);
    onStack.add(table);
    for (const key of keys) {
      if (key.table !== table) continue;
      const parent = key.references;
      if (!index.has(parent)) visit(parent);
      else if (!onStack.has(parent)) continue;
      low.set(table, Math.min(low.get(table) ?? own, low.get(parent) ?? own));
    }
    if (low.get(table) !== own) return;
    const component: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member);
      component.push(member);
      if (member === table) break;
    }
    found.push(component);
  };
  for (const table of tables) if (!index.has(table)) visit(table);
  return found;
}

/** The members of one cycle in an order no drop fails on, searched in listed order first. */
function orderCycle(members: readonly string[], allKeys: readonly ForeignKey[]): string[] {
  const keys = allKeys.filter((key) => members.includes(key.table) && members.includes(key.references));
  const dead = new Set<string>();
  const search = (left: readonly string[]): string[] | undefined => {
    if (left.length === 0) return [];
    const state = JSON.stringify(left);
    if (dead.has(state)) return undefined;
    for (const table of left) {
      if (!safeToDrop(table, left, keys)) continue;
      const rest = search(left.filter((other) => other !== table));
      if (rest) return [table, ...rest];
    }
    dead.add(state);
    return undefined;
  };
  const order = search(members);
  if (order) return order;
  const named = members.map((table) => `"${table}"`).join(", ");
  throw new Error(`No drop order clears ${named}: every order cascades into a table that names one already dropped.`);
}

/**
 * Whether `table` can go while `left` remain: every table a cascade from it reaches, itself included when the
 * cascade comes back, still has every table it references.
 */
function safeToDrop(table: string, left: readonly string[], keys: readonly ForeignKey[]): boolean {
  const present = new Set(left);
  const reached = new Set<string>();
  const frontier = [table];
  for (let current = frontier.pop(); current !== undefined; current = frontier.pop()) {
    for (const key of keys) {
      if (key.references !== current || !cascades(key) || !present.has(key.table) || reached.has(key.table)) continue;
      reached.add(key.table);
      frontier.push(key.table);
    }
  }
  return [...reached].every((reachedTable) =>
    keys.every((key) => key.table !== reachedTable || present.has(key.references)),
  );
}

/** A key that deletes the referencing rows when a referenced row is deleted. */
function cascades(key: ForeignKey): boolean {
  return key.onDelete.toUpperCase() === "CASCADE";
}

/** A table name as SQLite compares it: ASCII letters fold to lower case, nothing else does. */
function foldCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
