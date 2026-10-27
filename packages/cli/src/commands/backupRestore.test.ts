// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { DatabaseBackup } from "../backup/backup";
import type { DatabaseRestore } from "../backup/restore";
import { expectConforms } from "../test-utils/payloadContract";
import { formatBackupReport } from "./backup";
import { formatRestoreReport } from "./restore";

/** What `pithy backup` and `pithy restore` print, and the `--json` documents they promise (#848). */

const backed: DatabaseBackup = {
  binding: "DB",
  database: "app",
  folder: "DB",
  tables: 12,
  rows: 340,
  virtualTables: ["pithy_support_search"],
  restorable: true,
  oversized: [],
};

const render = { project: "acme", env: "prod", output: "backups/prod-2026-10-27T12-00-00Z", json: false };

describe("formatBackupReport", () => {
  test("one line per database, what was left out, and where the files are", () => {
    expect(
      formatBackupReport(
        [backed, { ...backed, binding: "EMAIL_SUPPRESSIONS", virtualTables: [], tables: 1, rows: 1 }],
        render,
      ),
    ).toBe(
      [
        "DB                  12 tables, 340 rows. Left out, rebuilt on restore: pithy_support_search.",
        "EMAIL_SUPPRESSIONS  1 table, 1 row.",
        "Written to backups/prod-2026-10-27T12-00-00Z.",
        "Done.",
        "",
      ].join("\n"),
    );
  });

  test("a row over D1's limit names its file and line, and the run ends without Done", () => {
    const text = formatBackupReport(
      [{ ...backed, restorable: false, oversized: [{ file: "data.sql", line: 812, table: "notes", bytes: 120_044 }] }],
      render,
    );
    expect(text).toContain("DB: DB/data.sql line 812 is 120044 bytes, over D1's 100,000-byte statement limit.");
    expect(text).toContain("not restorable to D1");
    expect(text).not.toContain("Done.");
  });

  test("--json is the payload the contract declares", async () => {
    await expectConforms("backup", () => formatBackupReport([backed], { ...render, json: true }));
  });
});

const restored: DatabaseRestore = {
  binding: "DB",
  database: "app",
  target: "acme-prod-recovery",
  migrations: 14,
  tables: 12,
  rows: 340,
  rebuilt: [
    { name: "pithy_support_search", how: "provisioned" },
    { name: "notes_index", how: "recreated-empty" },
  ],
};

describe("formatRestoreReport", () => {
  test("names each index it brought back, and how to point the binding at a recovery database", () => {
    const text = formatRestoreReport([restored], {
      project: "acme",
      env: "prod",
      json: false,
      recovery: { name: "acme-prod-recovery", id: "uuid-1", created: true },
    });
    expect(text).toBe(
      [
        "DB  14 migrations, 12 tables, 340 rows restored.",
        "DB: pithy_support_search rebuilt and backfilled.",
        "DB: notes_index recreated empty. Refill it yourself.",
        "Restored into acme-prod-recovery (uuid-1). Point DB's database_id at it in wrangler.jsonc to use it.",
        "Done.",
        "",
      ].join("\n"),
    );
  });

  test("--json is the payload the contract declares, with and without a recovery database", async () => {
    await expectConforms("restore", () =>
      formatRestoreReport([restored], { project: "acme", env: "prod", json: true }),
    );
    await expectConforms("restore", () =>
      formatRestoreReport([restored], {
        project: "acme",
        env: "prod",
        json: true,
        recovery: { name: "acme-prod-recovery", id: "uuid-1", created: false },
      }),
    );
  });
});
