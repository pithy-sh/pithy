// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type DeclaredTable, secretTablesLines, secretTablesReport } from "./report";

const customer: DeclaredTable = {
  worker: "api",
  table: "customer",
  keys: ["userId", "organizationId"],
  secrets: ["STRIPE_KEY", "WEBHOOK_SIG"],
};
const connection: DeclaredTable = {
  worker: "api",
  table: "connection",
  keys: ["installationId"],
  secrets: ["SIGNING_KEY"],
};

describe("secretTablesReport", () => {
  test("joins each declaration with what the vault holds, and names what only one side has", () => {
    const report = secretTablesReport([customer, connection], {
      newestKeyVersion: 4,
      tables: [
        {
          table: "customer",
          keys: ["userId", "organizationId"],
          secrets: [
            { name: "STRIPE_KEY", rows: 1204, keyVersions: { "4": 1204 } },
            { name: "WEBHOOK_SIG", rows: 1204, keyVersions: { "4": 1204 } },
          ],
        },
        { table: "legacy", keys: ["tenantId"], secrets: [{ name: "KEY", rows: 2, keyVersions: { "3": 2 } }] },
      ],
    });
    expect(report.tables.map((table) => [table.table, table.state, table.worker])).toEqual([
      ["customer", "migrated", "api"],
      ["connection", "not-migrated", "api"],
      ["legacy", "undeclared", null],
    ]);
    expect(report.behind).toBe(2);
    expect(report.tables[1]?.secrets).toEqual([{ name: "SIGNING_KEY", rows: 0, keyVersions: {} }]);
  });
});

describe("secretTablesLines", () => {
  test("one block per table: keys on the name line, then rows and the key version per secret", () => {
    const report = secretTablesReport([customer, { ...connection }], {
      newestKeyVersion: 4,
      tables: [
        {
          table: "customer",
          keys: ["userId", "organizationId"],
          secrets: [
            { name: "STRIPE_KEY", rows: 1204, keyVersions: { "4": 1204 } },
            { name: "WEBHOOK_SIG", rows: 1204, keyVersions: { "4": 1204 } },
          ],
        },
        {
          table: "connection",
          keys: ["installationId"],
          secrets: [{ name: "SIGNING_KEY", rows: 87, keyVersions: { "4": 87 } }],
        },
      ],
    });
    expect(secretTablesLines(report, "prod")).toEqual([
      "customer    userId, organizationId",
      "  STRIPE_KEY   1204 rows  key v4",
      "  WEBHOOK_SIG  1204 rows  key v4",
      "",
      "connection  installationId",
      "  SIGNING_KEY  87 rows  key v4",
    ]);
  });

  test("a spread names every version and closes with the rows a rotation did not reach", () => {
    const report = secretTablesReport([customer], {
      newestKeyVersion: 4,
      tables: [
        {
          table: "customer",
          keys: ["userId", "organizationId"],
          secrets: [
            { name: "STRIPE_KEY", rows: 1204, keyVersions: { "3": 12, "4": 1192 } },
            { name: "WEBHOOK_SIG", rows: 0, keyVersions: {} },
          ],
        },
      ],
    });
    expect(secretTablesLines(report, "prod")).toEqual([
      "customer  userId, organizationId",
      "  STRIPE_KEY   1204 rows  keys v3 12, v4 1192",
      "  WEBHOOK_SIG  0 rows",
      "",
      "12 rows are not on key v4. The last at-rest rotation did not reach them.",
    ]);
  });

  test("a table not migrated here says so and names the command", () => {
    const report = secretTablesReport([customer], { newestKeyVersion: null, tables: [] });
    expect(secretTablesLines(report, "staging")).toEqual([
      "customer  userId, organizationId — not migrated in staging. Run pithy migrate --env staging.",
    ]);
  });

  test("a project declaring nothing says that", () => {
    expect(secretTablesLines(secretTablesReport([], { newestKeyVersion: null, tables: [] }), "dev")).toEqual([
      "No secret tables declared.",
    ]);
  });
});
