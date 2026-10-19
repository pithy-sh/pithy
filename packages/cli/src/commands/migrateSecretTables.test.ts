// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { callerOf } from "@pithy-sh/core/src/cli/command";
import { secretTablesDatabase } from "@pithy-sh/secrets/src/tables/database";
import { defineSecretTable } from "@pithy-sh/secrets/src/tables/defineSecretTable";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { migrateProject, resolveWorkerScopes, type WorkerMigrationRun, type WorkerScope } from "../migrations/run";
import { expectConforms } from "../test-utils/payloadContract";
import migrate, { generatedNotApplied } from "./migrate";

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

/** What a run left behind: stdout, stderr, and the exit code it asked for (`undefined` for a normal return). */
interface Outcome {
  out: string;
  err: string;
  exit: number | undefined;
}

class Exited extends Error {}

async function run(args: Record<string, unknown>): Promise<Outcome> {
  const written: string[] = [];
  const errors: string[] = [];
  let exit: number | undefined;
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  const exiting = vi.spyOn(process, "exit").mockImplementation((code) => {
    exit = Number(code ?? 0);
    throw new Exited();
  });
  try {
    await migrate.run?.({ args: { rollback: false, json: false, "dry-run": false, ...args } } as never);
  } catch (error) {
    if (!(error instanceof Exited)) throw error;
  } finally {
    exiting.mockRestore();
    stderr.mockRestore();
    stdout.mockRestore();
    cwd.mockRestore();
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point.
  const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
  return { out: plain(written.join("")), err: plain(errors.join("")), exit };
}

async function invoke(args: Record<string, unknown>): Promise<string> {
  return (await run(args)).out;
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
  test("writes the migration, names it, and stops before applying anything — and does not exit as if it had", async () => {
    vi.mocked(resolveWorkerScopes).mockResolvedValue([api(true)]);
    const { out, err, exit } = await run({ env: "dev" });
    expect(out).toBe(
      [
        "New secret table: customer",
        "  + key     userId",
        "  + secret  STRIPE_KEY",
        "",
        "Wrote apps/api/migrations/secrets/0001_customer_init.ts",
        "Review it, then run migrate again.",
        "",
      ].join("\n"),
    );
    // Nothing was applied, so `pithy migrate && pithy deploy` must not go on to deploy: a person reviews first.
    expect(exit).toBe(5);
    expect(err).toContain("Nothing was applied.");
    expect(err).toContain("pithy migrate --env dev");
    expect(migrateProject).not.toHaveBeenCalled();
    expect((await readdir(join(root, "apps", "api", "migrations", "secrets"))).sort()).toEqual([
      "0001_customer_init.ts",
      "index.ts",
    ]);
  });

  test("--json carries what it wrote as generatedMigrations, with no workers migrated, and conforms to the payload", async () => {
    vi.mocked(resolveWorkerScopes).mockResolvedValue([api(true)]);
    const { out: written, err, exit } = await run({ env: "dev", json: true });
    expect(exit).toBe(5);
    expect(JSON.parse(err)).toMatchObject({ error: { code: "core/person_required" } });
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

  test("the refusal names the run again, and against prod says it as a person's decision rather than a fix", () => {
    const dev = generatedNotApplied(callerOf("migrate", { env: "dev", worker: "api" }), undefined);
    expect(dev.payload).toMatchObject({ code: "core/person_required" });
    expect(dev.payload.action).toContain("pithy migrate --env dev --worker api");
    const prod = generatedNotApplied(callerOf("migrate", { env: "prod" }), undefined);
    expect(prod.payload.action).toMatch(/^Review and commit what it wrote\. /);
  });

  test("--dry-run says what it would write and writes nothing", async () => {
    vi.mocked(resolveWorkerScopes).mockResolvedValue([api(true)]);
    const { out, exit } = await run({ env: "dev", "dry-run": true });
    expect(exit).toBeUndefined();
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
