// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { secretTablesDatabase } from "@pithy-sh/secrets/src/tables/database";
import { defineSecretTable } from "@pithy-sh/secrets/src/tables/defineSecretTable";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { migrateProject, resolveWorkerScopes, type WorkerMigrationRun, type WorkerScope } from "../migrations/run";
import { expectConforms } from "../test-utils/payloadContract";
import migrate from "./migrate";

/**
 * The command's half of #524: a forward run that writes a declared-table migration prints what it wrote and
 * **stops** — `migrateProject` is never called — and a run that writes nothing migrates as it always did.
 */

let root: string;

vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "acme" }),
  projectCloudflareAccount: async () => null,
}));

vi.mock("../migrations/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../migrations/run")>()),
  migrateProject: vi.fn(async (): Promise<WorkerMigrationRun[]> => []),
  resolveWorkerScopes: vi.fn(),
}));

const CustomerSecrets = defineSecretTable({
  name: "customer",
  keys: { userId: z.string().describe("The user.") },
  secrets: { STRIPE_KEY: { valueType: "text", rotatable: true } },
});

function api(declares: boolean): WorkerScope {
  const app = defineCapability({
    name: "app",
    requiredBindings: [],
    ...(declares ? { databases: { secrets: secretTablesDatabase({ tables: [CustomerSecrets] }) } } : {}),
  });
  return { name: "api", dir: join(root, "apps", "api"), capabilities: [app] };
}

async function invoke(args: Record<string, unknown>): Promise<string> {
  const written: string[] = [];
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await migrate.run?.({ args: { rollback: false, json: false, "dry-run": false, ...args } } as never);
  } finally {
    stdout.mockRestore();
    cwd.mockRestore();
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point.
  return written.join("").replace(/\u001b\[[0-9;]*m/g, "");
}

beforeEach(async () => {
  root = await mkdtemp(join(import.meta.dirname, "..", "..", ".e2e-migrate-tables-"));
  await mkdir(join(root, "apps", "api"), { recursive: true });
  vi.mocked(migrateProject).mockClear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pithy migrate with a declared secret table", () => {
  test("writes the migration, names it, and stops before applying anything", async () => {
    vi.mocked(resolveWorkerScopes).mockResolvedValue([api(true)]);
    const out = await invoke({ env: "dev" });
    expect(out).toBe(
      [
        "New secret table: customer",
        "  + key     userId",
        "  + secret  STRIPE_KEY",
        "",
        "Wrote apps/api/migrations/secrets/0001_customer_init.ts",
        "Review it, then run migrate again.",
        "",
        "Done.",
        "",
      ].join("\n"),
    );
    expect(migrateProject).not.toHaveBeenCalled();
    expect((await readdir(join(root, "apps", "api", "migrations", "secrets"))).sort()).toEqual([
      "0001_customer_init.ts",
      "index.ts",
    ]);
  });

  test("--json carries what it wrote as generatedMigrations, with no workers migrated, and conforms to the payload", async () => {
    vi.mocked(resolveWorkerScopes).mockResolvedValue([api(true)]);
    const written = await invoke({ env: "dev", json: true });
    const line = JSON.parse(written);
    expect(line).toMatchObject({
      command: "migrate",
      env: "dev",
      dryRun: false,
      workers: [],
      generatedMigrations: [
        {
          worker: "api",
          table: "customer",
          change: "create",
          file: "apps/api/migrations/secrets/0001_customer_init.ts",
        },
      ],
    });
    await expectConforms("migrate", written);
    expect(migrateProject).not.toHaveBeenCalled();
  });

  test("--dry-run says what it would write and writes nothing", async () => {
    vi.mocked(resolveWorkerScopes).mockResolvedValue([api(true)]);
    const out = await invoke({ env: "dev", "dry-run": true });
    expect(out).toContain("Would write apps/api/migrations/secrets/0001_customer_init.ts\nDry run. Nothing written.\n");
    await expect(readdir(join(root, "apps", "api", "migrations"))).rejects.toThrow();
    expect(migrateProject).not.toHaveBeenCalled();
  });

  test("a project declaring no table migrates as it always did", async () => {
    vi.mocked(resolveWorkerScopes).mockResolvedValue([api(false)]);
    await invoke({ env: "dev" });
    expect(migrateProject).toHaveBeenCalledTimes(1);
  });

  test("a rollback never generates", async () => {
    vi.mocked(resolveWorkerScopes).mockClear();
    await invoke({ env: "dev", rollback: true, group: "release-1" });
    expect(resolveWorkerScopes).not.toHaveBeenCalled();
  });
});
