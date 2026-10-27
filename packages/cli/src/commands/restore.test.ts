// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConflictError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import type { DatabaseRestore, RestoreOptions } from "../backup/restore";
import { scaffoldProject } from "../project/scaffold";
import { EXIT } from "../terminal/exitClass";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import { removeTempDir } from "../test-utils/tempRepo";
import { recoveryDatabase } from "./restore";

/**
 * **`--database <name>` resolves `<project>-<env>-<name>` (#848)** — locally as a store of that name, remotely
 * found by name through `d1Provisioner()` and created only when there is none. The Cloudflare clients are
 * replaced by one that records each lookup and create.
 */

const cloudflare = vi.hoisted(() => ({
  existing: new Map<string, string>(),
  asked: [] as string[],
}));

/**
 * The `restore` command itself, with the restore replaced by what each case needs it to do: what it was
 * handed, and what it answers or throws. What makes a restore refuse is `backup/roundTrip.test.ts`'s subject;
 * here it is the exit code and the document the command turns each answer into.
 */
const observed = vi.hoisted(() => ({
  options: undefined as RestoreOptions | undefined,
  run: (async () => []) as (options: RestoreOptions) => Promise<DatabaseRestore[]>,
  events: [] as CliAuditEvent[],
}));

vi.mock("../backup/restore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backup/restore")>()),
  runRestore: async (options: RestoreOptions) => {
    observed.options = options;
    return observed.run(options);
  },
}));

vi.mock("../audit/cliAudit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/cliAudit")>()),
  createRemoteCliAudit: async () => async (event: CliAuditEvent) => {
    observed.events.push(event);
  },
}));

vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: async () => ({
    d1Provisioner: () => ({
      findDatabaseByName: async (name: string) => {
        cloudflare.asked.push(`find ${name}`);
        const uuid = cloudflare.existing.get(name);
        return uuid === undefined ? null : { uuid, name };
      },
      createDatabase: async (name: string) => {
        cloudflare.asked.push(`create ${name}`);
        return { uuid: "made-uuid", name };
      },
    }),
  }),
}));

beforeEach(() => {
  cloudflare.existing = new Map();
  cloudflare.asked = [];
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recoveryDatabase", () => {
  test("locally, it is the store of that name, and nothing reaches Cloudflare", async () => {
    expect(await recoveryDatabase("acme", "dev", "recovery", null)).toEqual({
      name: "acme-dev-recovery",
      id: "acme-dev-recovery",
      created: false,
    });
    expect(cloudflare.asked).toEqual([]);
  });

  test("remotely, an existing database of that name is reused, and none is created", async () => {
    cloudflare.existing.set("acme-prod-recovery", "found-uuid");
    expect(await recoveryDatabase("acme", "prod", "recovery", null)).toEqual({
      name: "acme-prod-recovery",
      id: "found-uuid",
      created: false,
    });
    expect(cloudflare.asked).toEqual(["find acme-prod-recovery"]);
  });

  test("remotely, with none of that name, it is created and reported as created", async () => {
    expect(await recoveryDatabase("acme", "staging", "recovery", null)).toEqual({
      name: "acme-staging-recovery",
      id: "made-uuid",
      created: true,
    });
    expect(cloudflare.asked).toEqual(["find acme-staging-recovery", "create acme-staging-recovery"]);
  });
});

const RESTORED: DatabaseRestore = {
  binding: "DB",
  database: "app",
  target: "acme-dev-recovery",
  migrations: 3,
  tables: 4,
  rows: 8,
  rebuilt: [],
};

describe("pithy restore", () => {
  let dir: string;

  beforeEach(async () => {
    observed.options = undefined;
    observed.run = async () => [RESTORED];
    observed.events = [];
    dir = await mkdtemp(join(tmpdir(), "pithy-restore-"));
    await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
    await linkKitPackages(dir, ["core"]);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(dir);
  });

  /** Run the command to its refusal: the exit it asked for and the error document it wrote. */
  async function refused(args: string[]): Promise<{ exit: unknown; error: Record<string, unknown> }> {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    await expect(runCaptured("restore", args)).rejects.toThrow("exited");
    return { exit: exit.mock.calls[0]?.[0], error: JSON.parse(stderr.join("")).error };
  }

  test.each([
    ["migrations that differ", new PreconditionFailedError({ message: "differ", action: "a" }), EXIT.precondition],
    ["a database that is not empty", new ConflictError({ message: "not empty", action: "a" }), EXIT.precondition],
    [
      "a backup D1 cannot take back",
      new PreconditionFailedError({ message: "too big", action: "a" }),
      EXIT.precondition,
    ],
    ["a directory that holds no backup", new NotFoundError({ message: "none", action: "a" }), EXIT.precondition],
    ["--database over several folders", new ValidationError({ message: "several", action: "a" }), EXIT.usage],
  ])("%s exits as docs/commands/restore.md says, with the error document under --json", async (_name, thrown, code) => {
    observed.run = async () => {
      throw thrown;
    };
    const { exit, error } = await refused(["backups/one", "--env", "dev", "--json"]);
    expect(exit).toBe(code);
    expect(error).toMatchObject({ code: thrown.payload.code, message: thrown.payload.message, exit: code });
  });

  test("--database restores into the recovery database, and the document names it", async () => {
    observed.run = async (options) => {
      expect(await options.recovery?.()).toBe("acme-dev-recovery");
      return [RESTORED];
    };
    const written = await runCaptured("restore", [
      "backups/one",
      "--env",
      "dev",
      "--database",
      "recovery",
      "--worker",
      "api",
      "--binding",
      "DB",
      "--group",
      "rel-1",
      "--json",
    ]);
    await expectConforms("restore", written);
    expect(JSON.parse(written.join(""))).toMatchObject({
      command: "restore",
      env: "dev",
      recovery: { name: "acme-dev-recovery", id: "acme-dev-recovery", created: false },
      databases: [RESTORED],
    });
    expect(observed.options).toMatchObject({
      project: "acme",
      env: "dev",
      input: join(dir, "backups", "one"),
      worker: "api",
      binding: "DB",
      group: "rel-1",
    });
    // A local run reaches no shared system, so it records nothing.
    expect(observed.events).toEqual([]);
  });

  test("without --database there is no recovery database, and no recovery in the document", async () => {
    const written = await runCaptured("restore", ["backups/one", "--env", "dev", "--json"]);
    await expectConforms("restore", written);
    expect(JSON.parse(written.join(""))).not.toHaveProperty("recovery");
    expect(observed.options?.recovery).toBeUndefined();
  });

  test("off dev, a recovery database it creates is recorded at once, and the restore is handed the trail", async () => {
    observed.run = async (options) => {
      await options.recovery?.();
      await options.audit?.({ action: "restore/loaded", outcome: "success" });
      return [{ ...RESTORED, target: "made-uuid" }];
    };
    const written = await runCaptured("restore", [
      "backups/one",
      "--env",
      "staging",
      "--database",
      "recovery",
      "--json",
    ]);
    expect(JSON.parse(written.join(""))).toMatchObject({
      recovery: { name: "acme-staging-recovery", id: "made-uuid", created: true },
    });
    expect(observed.events).toEqual([
      {
        action: "restore/recovery_database_created",
        outcome: "success",
        severity: "warning",
        resourceType: "d1_database",
        resourceId: "acme-staging-recovery",
        metadata: { id: "made-uuid" },
      },
      { action: "restore/loaded", outcome: "success" },
    ]);
  });
});
