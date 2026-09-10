// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vector as vectorCapability } from "@pithy-sh/vector/src/capability";
import type { CommandDef } from "citty";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { scaffoldProject } from "../project/scaffold";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import vector from "./vector";

/**
 * **The `DB`-id refusal is a preflight, and this is the file that says what "preflight" means.**
 *
 * `docs/commands/vector.md` tells an operator the refusal happens *"rather than standing up an index with
 * nothing to fill it"*. It did not. The check lived in the `resolveEnv` closure the provisioner calls from
 * `deployWorker` — the **last** step — so `provision` refused after the index and every metadata index on it
 * had been created, and `reset --env prod` refused after the production index had been **deleted and
 * rebuilt**. A reset that dies there leaves an operator with a rebuilt, empty, unfillable index: the reset
 * confirmation authorized a reset, not a half of one, and `--confirm-reset` is no substitute for the order
 * being right (pithy-sh/pithy#512).
 *
 * **The assertion is the call log, not the exit code.** The command exited 1 before this change too — it
 * exited 1 having already deleted the index. So every case below drives the real citty subcommand against a
 * recording Cloudflare double and asserts that **nothing was created, destroyed or started**. An exit code
 * proves nothing here; a call log is the only thing that can tell a refusal from a rollback that never was.
 *
 * The provisioner is the **shipped** `CloudflareVectorProvisioner`, not a stub — the ordering under test is
 * the one between the command's gate and that class's Cloudflare calls, and a stubbed provisioner is exactly
 * the thing that cannot observe it. Only the REST clients underneath it are doubles, and `runWrangler` is
 * one too, so a regression cannot shell out to a real deploy on its way past.
 *
 * `reprocess` is here as well, and it was the neighbor that never ran the gate at all: it deploys nothing,
 * so `resolveEnv` was never called and an unready environment reached Workflow dispatch. It is gated now,
 * and the gate refuses nothing that could have worked — an environment only has a reprocess Workflow to
 * dispatch because a provision run deployed one, and that run required the id.
 */

/** The project name and Worker every fixture here is scaffolded with. */
const PROJECT = "acme";
const WORKER = "api";

/** The environment `pithy provision` has been run for, and the one it has not. */
const READY = "staging";
const UNREADY = "prod";

/** The project root and the app Worker's directory — two directories, because a real project has two. */
const fixture = vi.hoisted(() => ({ dir: "", workerDir: "" }));

/** The Workers the command resolves. */
const scope = vi.hoisted(() => ({ workers: [] as unknown[] }));

/**
 * Every Cloudflare call the run made, in order, each tagged by what it does to the account: `read:` observes,
 * `create:` and `destroy:` change it, `start:` sets work running. The tags are what {@link mutating} filters
 * on, so a call added to the double declares its own kind rather than being remembered by a list here.
 */
const cf = vi.hoisted(() => ({ calls: [] as string[] }));

/** The calls a refused run must not have made. */
function mutating(calls: readonly string[]): string[] {
  return calls.filter((call) => /^(create|destroy|start):/.test(call));
}

// `reset` audits, and the emitter reaches Cloudflare once credentials resolve. Nothing here is about audit.
vi.mock("../audit/cliAudit", () => ({ createRemoteCliAudit: async () => async () => {} }));

/**
 * The recording double, under the real provisioner. Every method the shipped `CloudflareVectorProvisioner`
 * reaches for is here, and each one writes down that it was reached.
 */
vi.mock("../cloudflare/clients", () => ({
  cloudflareClients: async () => ({
    vectorizeProvisioner: () => ({
      validateServiceAccess: async () => {
        cf.calls.push("read: vectorize service access");
        return true;
      },
      findIndexByName: async () => {
        cf.calls.push("read: find index by name");
        return null;
      },
      createIndex: async (indexName: string) => {
        cf.calls.push(`create: index ${indexName}`);
        return { name: indexName };
      },
      listMetadataIndexes: async () => {
        cf.calls.push("read: list metadata indexes");
        return [];
      },
      createMetadataIndex: async (indexName: string, propertyName: string) => {
        cf.calls.push(`create: metadata index ${indexName}.${propertyName}`);
      },
      deleteIndex: async (indexName: string) => {
        cf.calls.push(`destroy: index ${indexName}`);
      },
    }),
    workers: () => ({
      accountSubdomain: async () => {
        cf.calls.push("read: workers.dev subdomain");
        return PROJECT;
      },
    }),
  }),
  cloudflareWorkflows: async () => ({
    dispatchAndPoll: async (name: string) => {
      cf.calls.push(`start: workflow ${name}`);
      return { scanned: 0, reembedded: 0 };
    },
  }),
}));

// The deploy, recorded rather than run. `readWranglerConfig` and `writeWranglerConfig` stay real — the
// wrangler file this whole gate reads is the one the real scaffolder wrote.
vi.mock("../project/wrangler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/wrangler")>()),
  runWrangler: async (args: string[]) => {
    cf.calls.push(`create: wrangler ${args.join(" ")}`);
  },
}));

// Capabilities are per Worker and there is no `apps/` under the test runner's cwd, so the set is supplied.
vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveWorkers: async () => scope.workers,
  resolveSingleWorker: async () => scope.workers[0],
}));

// Only the root config is stubbed. `requireProjectName` stays real.
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: PROJECT, environments: [READY, UNREADY] }),
  projectCloudflareAccount: async () => null,
}));

/** The one index the fixture project declares, with one filterable field so a metadata index is declared. */
function vectorWorkers(dir: string): unknown[] {
  return [
    {
      name: WORKER,
      dir,
      config: {},
      capabilities: [
        vectorCapability({
          indexes: {
            docs: {
              model: "@cf/baai/bge-base-en-v1.5",
              dimensions: 768,
              metadata: z.object({
                ownerId: z.string().describe("Who owns the document.").meta({ filterable: true }),
              }),
            },
          },
        }),
      ],
      target: {},
    },
  ];
}

/** One environment stanza in the app Worker's `wrangler.jsonc`. */
interface Stanza {
  d1_databases?: { binding: string; database_id?: string }[];
}

/** Put one environment in the state `pithy provision --env <name>` leaves: a `DB` binding with a real id. */
async function provisionEnvironment(workerDir: string, env: string, databaseId: string): Promise<void> {
  const config = (await readWranglerConfig(workerDir)) as { env?: Record<string, Stanza> };
  const stanza = config.env?.[env];
  if (!stanza) throw new Error(`the scaffolded ${WORKER} worker has no env.${env} stanza`);
  stanza.d1_databases = [{ binding: "DB", database_id: databaseId }];
  await writeWranglerConfig(workerDir, config);
}

/** What a run wrote and the code it exited with. */
interface Run {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

/** Drive one `pithy vector` subcommand's real `run` to completion, from inside the fixture project. */
async function runSubcommand(name: string, args: Record<string, unknown>): Promise<Run> {
  const entry = (vector.subCommands as Record<string, CommandDef>)[name];
  if (!entry) throw new Error(`expected a ${name} subcommand on pithy vector`);

  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(fixture.dir);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  // `withErrorReporting` exits the process after reporting; throwing instead keeps the run in this test.
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error("exited");
  }) as never);
  try {
    await entry.run?.({ args, rawArgs: [] } as never);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "exited") throw error;
  } finally {
    cwd.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
  }
  return { stdout: out.join(""), stderr: err.join(""), exitCode };
}

/** The `--json` error payload a refused run reported. */
function refusal(run: Run): { code: string; message: string } {
  return (JSON.parse(run.stderr) as { error: { code: string; message: string } }).error;
}

/** The arguments each subcommand needs to reach its first Cloudflare call, for a given environment. */
function argsFor(name: string, env: string): Record<string, unknown> {
  if (name === "reset") {
    // The reset gate is answered, deliberately. An operator who confirms a reset has confirmed a reset, and
    // this file is about what happens **after** they do.
    return { env, json: true, "confirm-reset": `yes, i really want to reset ${env}` };
  }
  if (name === "reprocess") return { env, json: true, all: false };
  return { env, json: true };
}

describe("pithy vector refuses an unready environment before it creates or destroys anything", () => {
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-vector-preflight-"));
    await scaffoldProject({ targetDir: dir, appName: PROJECT, worker: WORKER });
    fixture.dir = dir;
    fixture.workerDir = join(dir, "apps", WORKER);
    // Staging is brought up; production is left as a bring-up leaves it, with no app database.
    await provisionEnvironment(fixture.workerDir, READY, "db-staging");
  });

  beforeEach(() => {
    cf.calls = [];
    scope.workers = vectorWorkers(fixture.workerDir);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-acme");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-acme");
  });

  test.each(["provision", "reset", "reprocess"])(
    "%s makes no creating or destroying call against an environment with no DB id",
    async (name) => {
      const run = await runSubcommand(name, argsFor(name, UNREADY));

      // The assertion. `reset` was the case that mattered: it reached here having already run
      // `destroy: index acme-prod-vector-docs` and `create: index acme-prod-vector-docs`.
      expect(mutating(cf.calls)).toEqual([]);
      // And in fact nothing at all: the gate is a local file read, so it lands before the REST clients
      // are even constructed.
      expect(cf.calls).toEqual([]);
      expect(run.exitCode).toBe(1);
      expect(refusal(run).message).toBe(`${WORKER}'s wrangler.jsonc has no DB database_id for ${UNREADY}.`);
      expect(refusal(run).code).toBe("validation/invalid_input");
    },
  );

  /**
   * The other half, and the one that keeps the gate honest: a refusal that refuses everything is not a
   * preflight, it is an outage. `reprocess` carries it because `reprocess` is what the gate newly covers —
   * and because it is the one subcommand whose whole job is a Cloudflare call, so "did it get through" has
   * an unambiguous answer in the same call log.
   */
  test("a ready environment reaches Cloudflare and dispatches the reprocess workflow", async () => {
    const run = await runSubcommand("reprocess", argsFor("reprocess", READY));

    expect(run.exitCode).toBeUndefined();
    expect(cf.calls).toEqual([`start: workflow ${PROJECT}-${READY}-vector-reprocess`]);
  });
});
