// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { isPersonColumn, personColumnsOf, personRowGaps } from "./personColumns";

/** The rule that holds a capability to answering for a person's rows (#814). */

const Row = (columns: string[]) =>
  z.object(Object.fromEntries(columns.map((column) => [column, z.string().describe(column)]))).describe("A row.");

const holding = (name: string, columns: string[], purge?: { subject: string; export?: unknown }[]) => ({
  name,
  databases: { app: { binding: "DB", tables: { [`${name}Rows`]: Row(["id", ...columns]) } } },
  ...(purge ? { purge } : {}),
});

describe("isPersonColumn", () => {
  test("an id that names a person, either side of a pair, or an address", () => {
    for (const column of ["userId", "ownerId", "subjectId", "actorId", "winnerUserId", "inviteeId", "userB"]) {
      expect(isPersonColumn(column), column).toBe(true);
    }
    for (const column of ["email", "recipient", "toAddress", "fromAddress"]) expect(isPersonColumn(column)).toBe(true);
  });

  test("not an id of something else", () => {
    for (const column of ["id", "organizationId", "sessionId", "boardKey", "storageKey", "jobId"]) {
      expect(isPersonColumn(column), column).toBe(false);
    }
  });
});

describe("personRowGaps", () => {
  test("a capability with a person column and no user contribution is a gap, naming the columns", () => {
    expect(personRowGaps([holding("games", ["userId", "score"])])).toEqual([
      { capability: "games", columns: ["gamesRows.userId"], gap: "no_contribution" },
    ]);
  });

  test("one with a contribution for an organization only is still a gap: the person is not answered for", () => {
    expect(personRowGaps([holding("files", ["ownerId"], [{ subject: "organization" }])])[0]?.gap).toBe(
      "no_contribution",
    );
  });

  test("one with a user contribution that does not export is a gap", () => {
    expect(personRowGaps([holding("files", ["ownerId"], [{ subject: "user" }])])).toEqual([
      { capability: "files", columns: ["filesRows.ownerId"], gap: "no_export" },
    ]);
  });

  test("one that erases or retains and exports passes, and one with no person column needs nothing", () => {
    const exports = async () => ({});
    expect(
      personRowGaps([
        holding("files", ["ownerId"], [{ subject: "user", export: exports }]),
        holding("flags", ["name", "enabled"]),
      ]),
    ).toEqual([]);
  });

  test("personColumnsOf reads every table of every database", () => {
    expect(
      personColumnsOf({
        name: "mail",
        databases: {
          app: { binding: "DB", tables: { jobs: Row(["id", "toAddress"]) } },
          list: { binding: "LIST", tables: { suppressions: Row(["id", "email"]) } },
        },
      }),
    ).toEqual(["jobs.toAddress", "suppressions.email"]);
  });
});
