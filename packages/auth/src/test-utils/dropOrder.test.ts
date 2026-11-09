// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { dropOrder, type ForeignKey } from "./dropOrder";

/** `table` references `references`, and deleting a referenced row does `onDelete` to it. */
function fk(table: string, references: string, onDelete = "CASCADE"): ForeignKey {
  return { table, references, onDelete };
}

/** True when `first` is dropped before `then`. */
function before(order: readonly string[], first: string, then: string): boolean {
  return order.indexOf(first) < order.indexOf(then);
}

describe("dropOrder", () => {
  test("tables with no foreign keys keep the order they were listed in", () => {
    expect(dropOrder(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });

  test("a table that references two others is dropped before both", () => {
    const order = dropOrder(["parent_a", "parent_b", "child"], [fk("child", "parent_a"), fk("child", "parent_b")]);
    expect(order).toEqual(["child", "parent_a", "parent_b"]);
  });

  test("a self-reference does not hold a table back", () => {
    const keys = [fk("category", "owner"), fk("category", "category")];
    expect(dropOrder(["owner", "category"], keys)).toEqual(["category", "owner"]);
  });

  test("the references decide, not the order the tables were created in", () => {
    const keys = [fk("post", "author"), fk("post", "topic"), fk("review", "post"), fk("review", "author")];
    const order = dropOrder(["post", "author", "topic", "review"], keys);
    expect(order).toEqual(["review", "post", "author", "topic"]);
  });

  test("a chain is dropped from its far end", () => {
    expect(dropOrder(["a", "b", "c"], [fk("b", "a"), fk("c", "b")])).toEqual(["c", "b", "a"]);
  });

  test("a reference to a table that is not listed is no constraint", () => {
    expect(dropOrder(["a"], [fk("a", "gone")])).toEqual(["a"]);
  });

  test("a two-table cycle is dropped whole, in the order listed", () => {
    expect(dropOrder(["ring_a", "ring_b"], [fk("ring_a", "ring_b"), fk("ring_b", "ring_a")])).toEqual([
      "ring_a",
      "ring_b",
    ]);
  });

  test("tables that reference a cycle go before it, and the cycle before what it references", () => {
    const keys = [fk("ca", "cb"), fk("cb", "ca"), fk("ca", "root"), fk("leaf", "cb")];
    const order = dropOrder(["root", "ca", "cb", "leaf"], keys);
    expect(order[0]).toBe("leaf");
    expect(order[3]).toBe("root");
  });

  test("in a cycle, a table is not dropped while a cascade from it reaches a table whose parent is gone", () => {
    // Dropping `b` first leaves `a` referencing it. Dropping `a` next cascades into `c`, back into `a`, and
    // `a` still names `b`.
    const keys = [fk("a", "b"), fk("a", "c"), fk("a", "d"), fk("b", "a"), fk("c", "a"), fk("d", "a")];
    const order = dropOrder(["b", "a", "c", "d"], keys);
    expect(order[0]).toBe("a");
  });

  test("a self-reference inside a cycle is followed like any other cascade", () => {
    const keys = [fk("a", "b"), fk("b", "a"), fk("b", "b")];
    expect(dropOrder(["a", "b"], keys)).toEqual(["b", "a"]);
  });

  test("a key with no action on delete cascades nowhere, so a cycle of them drops in any order", () => {
    const keys = ["p", "q", "r"].flatMap((table) =>
      ["p", "q", "r"].filter((other) => other !== table).map((other) => fk(table, other, "NO ACTION")),
    );
    expect(dropOrder(["p", "q", "r"], keys)).toEqual(["p", "q", "r"]);
  });

  test("a cycle that no order can drop is refused, naming its tables", () => {
    const keys = ["p", "q", "r"].flatMap((table) =>
      ["p", "q", "r"].filter((other) => other !== table).map((other) => fk(table, other)),
    );
    expect(() => dropOrder(["p", "q", "r"], keys)).toThrow(/"p", "q", "r"/);
  });

  test("set null rewrites only the referencing column, so a cycle of set null keys drops in listed order", () => {
    const keys = ["p", "q", "r"].flatMap((table) =>
      ["p", "q", "r"].filter((other) => other !== table).map((other) => fk(table, other, "SET NULL")),
    );
    expect(dropOrder(["p", "q", "r"], keys)).toEqual(["p", "q", "r"]);
  });

  test("set default is treated as set null", () => {
    const keys = ["p", "q", "r"].flatMap((table) =>
      ["p", "q", "r"].filter((other) => other !== table).map((other) => fk(table, other, "SET DEFAULT")),
    );
    expect(dropOrder(["p", "q", "r"], keys)).toEqual(["p", "q", "r"]);
  });

  test("a cascade does not travel on through a set null key", () => {
    // Dropping `a` cascades into `b`; `b`'s rows set `c`'s column to null and go no further, so `c` still
    // naming the dropped `d` does not matter. `c` and `d` stay in the cycle through `b`.
    const keys = [fk("b", "a"), fk("a", "b"), fk("c", "b", "SET NULL"), fk("b", "c"), fk("c", "d"), fk("d", "c")];
    const order = dropOrder(["d", "a", "b", "c"], keys);
    expect(order).toEqual(["d", "a", "b", "c"]);
  });

  test("a reference spelled in another case names the listed table, as it does in SQLite", () => {
    const keys = [fk("child", "PARENT_A"), fk("Child", "Parent_B")];
    expect(dropOrder(["parent_a", "parent_b", "child"], keys)).toEqual(["child", "parent_a", "parent_b"]);
  });

  test("every table listed is in the order exactly once", () => {
    const keys = [fk("b", "a"), fk("c", "a"), fk("c", "b"), fk("a", "c"), fk("d", "c")];
    const order = dropOrder(["a", "b", "c", "d", "e"], keys);
    expect([...order].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(before(order, "d", "c")).toBe(true);
  });
});
