// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DatabaseBackup } from "../backup/backup";
import { scaffoldProject } from "../project/scaffold";
import { EXIT } from "../terminal/exitClass";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import { removeTempDir } from "../test-utils/tempRepo";

/**
 * **`pithy backup` exits 1 when D1 cannot take a backup back (#848)** — the real command, in a scaffolded
 * project, with the dump itself replaced by its report: what makes a database unrestorable is
 * `backup/roundTrip.test.ts`'s subject; here it is what the command does with the answer. A CI job that
 * backs up has to notice a backup it cannot restore.
 */

const observed = vi.hoisted(() => ({
  report: [] as DatabaseBackup[],
  output: "",
  audit: undefined as ((event: { action: string; outcome: string }) => Promise<void>) | undefined,
  events: [] as { action: string; outcome: string }[],
}));

vi.mock("../backup/backup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backup/backup")>()),
  runBackup: async (options: { output: string; audit?: typeof observed.audit }) => {
    observed.output = options.output;
    observed.audit = options.audit;
    return observed.report;
  },
}));

vi.mock("../audit/cliAudit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/cliAudit")>()),
  createRemoteCliAudit: async () => async (event: { action: string; outcome: string }) => {
    observed.events.push(event);
  },
}));

const RESTORABLE: DatabaseBackup = {
  binding: "DB",
  database: "app",
  folder: "DB",
  tables: 2,
  rows: 3,
  virtualTables: [],
  restorable: true,
  oversized: [],
};

let dir: string;

beforeEach(async () => {
  observed.report = [];
  observed.audit = undefined;
  observed.events = [];
  dir = await mkdtemp(join(tmpdir(), "pithy-backup-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await removeTempDir(dir);
});

describe("pithy backup --env dev", () => {
  test("a backup D1 can take back exits 0 and ends Done.", async () => {
    observed.report = [RESTORABLE];
    const written = await runCaptured("backup", ["--env", "dev", "--output", "out"]);
    expect(written.join("")).toMatch(/Done\.\n$/);
    expect(observed.output).toBe(join(dir, "out"));
    expect(process.exitCode).toBeUndefined();
  });

  test("a row over D1's statement limit keeps the files, reports them, and exits 1", async () => {
    observed.report = [
      RESTORABLE,
      {
        ...RESTORABLE,
        binding: "BIG",
        folder: "BIG",
        restorable: false,
        oversized: [{ file: "data.sql", line: 4, table: "things", bytes: 120_100 }],
      },
    ];
    const written = await runCaptured("backup", ["--env", "dev", "--output", "out", "--json"]);
    await expectConforms("backup", written);
    expect(JSON.parse(written.join(""))).toMatchObject({ restorable: false });
    expect(process.exitCode).toBe(EXIT.failed);
  });
});

describe("pithy backup --env staging", () => {
  test("the backup is handed the environment's audit trail, so the export leaves a record", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
    observed.report = [RESTORABLE];
    await runCaptured("backup", ["--env", "staging", "--output", "out", "--json"]);
    await observed.audit?.({ action: "backup/exported", outcome: "success" });
    expect(observed.events).toEqual([{ action: "backup/exported", outcome: "success" }]);
    vi.unstubAllEnvs();
  });
});
