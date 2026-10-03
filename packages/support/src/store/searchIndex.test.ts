// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  SEARCH_OBJECTS,
  SEARCH_TABLE,
  SEARCH_TRIGGERS,
  searchIndexAction,
  searchIndexState,
  searchTriggerStatements,
} from "./searchIndex";

/**
 * The two ways a trigger body is wrong in a way no Miniflare test can see.
 *
 * **Casing.** `BEGIN` and `END` are the compound-statement delimiters, and remote D1 rejects a lowercase
 * body as `incomplete input [code: 7500]` while Miniflare accepts it. So the one place the casing could
 * drift is held here, in a plain unit test that fails the moment somebody lowercases a word.
 *
 * **Identifiers.** `CamelCasePlugin` snake-cases what the query builder emits and never touches a string
 * inside a `sql` template, so a trigger body is the one place in the package that has to spell the
 * physical column names itself. `NEW.textBody` would compile, pass review, and fail at provision time on
 * the only database that matters.
 */
describe("the FTS triggers' SQL", () => {
  const statements = searchTriggerStatements();

  test("there is one statement per trigger, and the names match", () => {
    expect(statements).toHaveLength(SEARCH_TRIGGERS.length);
    for (const [index, name] of SEARCH_TRIGGERS.entries()) {
      expect(statements[index]).toContain(`CREATE TRIGGER ${name}`);
    }
  });

  test("the set covers insert, update and delete — the three ways the table moves", () => {
    const bodies = statements.join("\n");
    expect(bodies).toContain("AFTER INSERT ON pithy_support_messages");
    expect(bodies).toContain("AFTER UPDATE ON pithy_support_messages");
    expect(bodies).toContain("AFTER DELETE ON pithy_support_messages");
  });

  test("BEGIN and END are uppercase in every body — remote D1 rejects them lowercased", () => {
    for (const statement of statements) {
      expect(statement).toMatch(/\bBEGIN\b/);
      expect(statement).toMatch(/\bEND\b/);
      // The assertion that actually fails on a lowercased body. `\b` would match inside `beginning`,
      // which is why the whole statement is searched for the bare words rather than for a prefix.
      expect(statement).not.toMatch(/\bbegin\b/);
      expect(statement).not.toMatch(/\bend\b/);
    }
  });

  test("every column is the physical snake_case name, never a camelCase key from data/tables.ts", () => {
    const bodies = statements.join("\n");
    expect(bodies).toContain("NEW.thread_id");
    expect(bodies).toContain("NEW.text_body");
    expect(bodies).not.toContain("threadId");
    expect(bodies).not.toContain("textBody");
    expect(bodies).not.toContain("messageId");
  });

  test("the insert and update bodies replace rather than append, so a re-write never double-indexes", () => {
    const [insert, update] = statements;
    expect(insert).toContain("DELETE FROM pithy_support_search WHERE message_id = NEW.id");
    expect(update).toContain("DELETE FROM pithy_support_search WHERE message_id = OLD.id");
  });
});

/**
 * Reading `sqlite_master` into the two facts a provisioner acts on, and choosing what to do about them.
 *
 * Split out from the statements themselves because this is the half with branches, and the half an
 * upgrade depends on: the one state the old shape could not see is **table present, triggers absent**,
 * which is exactly what an adopter who deployed this release without re-provisioning has.
 */
describe("what a provision run reads, and what it decides", () => {
  test("the names queried are the table and the three triggers, and nothing else", () => {
    expect(SEARCH_OBJECTS).toEqual([SEARCH_TABLE, ...SEARCH_TRIGGERS]);
  });

  test("a listing is read into the two facts that matter", () => {
    expect(searchIndexState([])).toEqual({ table: false, triggers: "none" });
    expect(searchIndexState([SEARCH_TABLE])).toEqual({ table: true, triggers: "none" });
    expect(searchIndexState([...SEARCH_OBJECTS])).toEqual({ table: true, triggers: "all" });
  });

  test("a partial set of triggers is its own state, not a pass and not an absence", () => {
    // Two of three means one `CREATE TRIGGER` failed or one was dropped by hand, and the consequence is
    // per statement kind: updates or deletes go unindexed while inserts look fine. Folding it into
    // `none` would also hide a stray trigger from a teardown that has to clear it.
    expect(searchIndexState([SEARCH_TABLE, SEARCH_TRIGGERS[0], SEARCH_TRIGGERS[1]])).toEqual({
      table: true,
      triggers: "some",
    });
  });

  test("names belonging to something else never count", () => {
    expect(searchIndexState(["pithy_support_messages", "pithy_auth_users"])).toEqual({
      table: false,
      triggers: "none",
    });
  });

  test("the index is provisioned from nothing when the flag is on", () => {
    expect(searchIndexAction({ table: false, triggers: "none" }, true)).toBe("create");
  });

  test("a table with no triggers is repaired, which is the upgrade path", () => {
    // **The state this release introduces.** The `indexMessage` calls are gone from every write path,
    // so an adopter who upgraded and deployed without re-running `pithy support provision` has a table
    // nothing maintains. `pithy doctor` names the command; this is what the command then does.
    expect(searchIndexAction({ table: true, triggers: "none" }, true)).toBe("repair");
  });

  test("a half-triggered table is repaired too", () => {
    expect(searchIndexAction({ table: true, triggers: "some" }, true)).toBe("repair");
  });

  test("a fully provisioned index is left alone", () => {
    expect(searchIndexAction({ table: true, triggers: "all" }, true)).toBe("none");
  });

  test("turning the flag off drops what is there, and does nothing when nothing is", () => {
    expect(searchIndexAction({ table: true, triggers: "all" }, false)).toBe("drop");
    expect(searchIndexAction({ table: false, triggers: "none" }, false)).toBe("none");
  });

  test("a trigger left behind by a hand-dropped table is dropped too, even on its own", () => {
    // A trigger body resolves its table at run time, so a trigger can outlive the table it writes to —
    // and while it does, every message write fails. `search.fts: false` has to clear that, not read it
    // as nothing to do.
    expect(searchIndexAction({ table: false, triggers: "all" }, false)).toBe("drop");
    expect(searchIndexAction({ table: false, triggers: "some" }, false)).toBe("drop");
  });

  test("a table missing under its own triggers is created rather than only repaired", () => {
    expect(searchIndexAction({ table: false, triggers: "all" }, true)).toBe("create");
  });
});
