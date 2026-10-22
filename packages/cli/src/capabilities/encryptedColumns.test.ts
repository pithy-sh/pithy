// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { phi } from "@pithy-sh/core/src/privacy/classes";
import { encrypted, encryptedTable } from "@pithy-sh/core/src/privacy/encrypted";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { ResolvedWorker } from "../project/workerScope";
import { projectEncryptedColumns } from "./encryptedColumns";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".encrypted-columns-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const Patient = encryptedTable(
  z.object({ id: z.string().describe("id"), diagnosis: encrypted(phi(z.string().describe("The condition."))) }),
  { name: "patient", key: "id" },
);

function worker(capabilities: Capability[]): ResolvedWorker {
  return { name: "api", dir, config: {} as never, capabilities, target: {} as never };
}

const clinic = (tables: Record<string, z.ZodType>) =>
  defineCapability({ name: "app", requiredBindings: [], databases: { app: { binding: "DB", tables } } });

describe("projectEncryptedColumns", () => {
  test("derives every Worker's encrypted columns, with each database's id from the environment's stanza", async () => {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({
        env: {
          staging: { d1_databases: [{ binding: "DB", database_name: "acme-staging-db", database_id: "db-uuid" }] },
        },
      }),
    );
    const stamped = await projectEncryptedColumns({
      projectDir: dir,
      env: "staging",
      workers: [worker([clinic({ patients: Patient })]), worker([clinic({ patients: Patient })])],
    });
    expect(stamped.stamp.columns.map((column) => `${column.binding}:${column.table}.${column.column}`)).toEqual([
      "DB:patients.diagnosis",
    ]);
    expect(stamped.databases).toEqual([{ binding: "DB", databaseName: "acme-staging-db", databaseId: "db-uuid" }]);
  });

  test("refuses a stamped binding the environment has no database for, naming the provision", async () => {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({ env: { prod: { d1_databases: [{ binding: "DB" }] } } }),
    );
    await expect(
      projectEncryptedColumns({ projectDir: dir, env: "prod", workers: [worker([clinic({ patients: Patient })])] }),
    ).rejects.toThrow(/prod has no DB database yet/);
  });

  test("refuses an encrypted table with no encryptedTable() declaration", async () => {
    const Bare = z.object({ id: z.string(), diagnosis: encrypted(z.string()) });
    await expect(
      projectEncryptedColumns({ projectDir: dir, env: "staging", workers: [worker([clinic({ patients: Bare })])] }),
    ).rejects.toThrow(/declares no table/);
  });

  test("a set nobody can read is an unread source, which keeps every retirement from going ahead", async () => {
    const stamped = await projectEncryptedColumns({
      projectDir: dir,
      env: "staging",
      workers: { unknown: "api threw" },
    });
    expect(stamped).toEqual({ stamp: { columns: [], unread: ["api threw"], unrotatable: [] }, databases: [] });
  });
});
