// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
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
 * **`pithy vector` acts on an app Worker's `wrangler.jsonc`, because there is no root one.**
 *
 * Every deployable Worker lives in `apps/<name>/` with its own config and the project root carries identity
 * and policy alone (CLAUDE.md §CLI; `project/scaffold.test.ts` asserts the root file's absence by name). This
 * command read the root file in **three** places — the app database id in `buildResolveEnv`, the
 * `VECTOR_PROVISIONED` record in `recordProvisioned`, and the `vectorize`/`workflows` bindings in
 * `recordBindings` — so every subcommand was unusable in every scaffolded project, and it died on a raw
 * Node `ENOENT` stack rather than on a `PithyError` naming the remedy (pithy-sh/pithy#512).
 *
 * It sat outside the six that took skip-and-report, correctly: every `pithy vector` subcommand takes a
 * required `--env`, so nothing about it fans out and its refusal has one environment to be about. The
 * *routing* correction was never about fanning out, and the exclusion from one rule was read as an
 * exclusion from the other. `ci/environmentSkips.test.ts` holds the source-level half — no command reads a
 * root `wrangler.jsonc`, quantified over the whole directory rather than over the six — and this holds the
 * behavior: the real citty subcommand, against a project the **real scaffolder** just built on disk.
 *
 * Everything that would reach Cloudflare is replaced and nothing else is. The command body, the
 * `provisionVector` orchestration, the record projection, the binding derivation and both `wrangler.jsonc`
 * writes are the shipped ones.
 */

/** The project name and Worker every fixture here is scaffolded with. */
const PROJECT = "acme";
const WORKER = "api";

/** The project root and the app Worker's directory — two directories, because a real project has two. */
const fixture = vi.hoisted(() => ({ dir: "", workerDir: "" }));

/** The Workers the command resolves, and what the stubbed provisioner was asked to do. */
const scope = vi.hoisted(() => ({ workers: [] as unknown[] }));
const recorded = vi.hoisted(() => ({ envs: [] as string[] }));

// `reset` audits; nothing here is about auditing, and the emitter reaches Cloudflare once credentials resolve.
vi.mock("../audit/cliAudit", () => ({ createRemoteCliAudit: async () => async () => {} }));

// No client is constructed against a real account. The provisioner that would use them is stubbed below.
vi.mock("../cloudflare/clients", () => ({
  cloudflareClients: async () => ({}),
  cloudflareWorkflows: async () => ({}),
}));

// Capabilities are per Worker and there is no `apps/` under the test runner's cwd, so the set is supplied.
// `projectCapabilities` stays real — it is what `loadVectorConfig` reads the vector config out of.
vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveWorkers: async () => scope.workers,
  resolveSingleWorker: async () => scope.workers[0],
}));

// Only the root config is stubbed. `requireProjectName` stays real, so the project name every index name
// leads with is resolved the way a run resolves it.
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: PROJECT, environments: ["staging", "prod"] }),
  projectCloudflareAccount: async () => null,
}));

/**
 * The live provisioner, replaced. `loadVector` stays real, so `provisionVector`, `toProvisionRecord`,
 * `vectorWorkflowRegistry` and `VECTOR_PROVISIONED_VAR` are the package's own.
 *
 * `deployWorker` calls the injected `resolveEnv`, which is the whole point: that closure is the app
 * database read, and a run that never invokes it would pass this file with the defect intact.
 */
vi.mock("../capabilities/vectorProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/vectorProvisioner")>()),
  CloudflareVectorProvisioner: class {
    #resolveEnv: (env: string) => Promise<{ appDatabaseId: string }>;
    constructor(options: { resolveEnv: (env: string) => Promise<{ appDatabaseId: string }> }) {
      this.#resolveEnv = options.resolveEnv;
    }
    async preflight() {}
    async ensureIndex(indexName: string) {
      return { name: indexName };
    }
    async ensureMetadataIndexes() {
      return { missing: [], extra: [], present: [] };
    }
    async deployWorker(env: string) {
      await this.#resolveEnv(env);
      recorded.envs.push(env);
    }
  },
}));

/** The one index the fixture project declares, with one filterable field so the record carries something. */
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

/** A project built the way `pithy init` builds one — by the real scaffolder, never by a literal here. */
async function scaffoldedProject(prefix: string): Promise<{ dir: string; workerDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await scaffoldProject({ targetDir: dir, appName: PROJECT, worker: WORKER });
  return { dir, workerDir: join(dir, "apps", WORKER) };
}

/** One environment stanza in the app Worker's `wrangler.jsonc`, as this file reads and writes it. */
interface Stanza {
  d1_databases?: { binding: string; database_id?: string }[];
  vars?: Record<string, string>;
  vectorize?: { binding: string; index_name?: string }[];
  workflows?: { binding: string; name?: string; class_name?: string }[];
}

/** Put one environment in the state `pithy provision --env <name>` leaves: a `DB` binding with a real id. */
async function provisionEnvironment(workerDir: string, env: string, databaseId: string): Promise<void> {
  const config = (await readWranglerConfig(workerDir)) as { env?: Record<string, Stanza> };
  const stanza = config.env?.[env];
  if (!stanza) throw new Error(`the scaffolded ${WORKER} worker has no env.${env} stanza`);
  stanza.d1_databases = [{ binding: "DB", database_id: databaseId }];
  await writeWranglerConfig(workerDir, config);
}

/** One environment's stanza in the app Worker's config, after a run. */
async function stanza(workerDir: string, env: string): Promise<Stanza> {
  const config = (await readWranglerConfig(workerDir)) as { env?: Record<string, Stanza> };
  const found = config.env?.[env];
  if (!found) throw new Error(`no env.${env} stanza`);
  return found;
}

/** What a run wrote and the code it exited with. */
interface Run {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

/** Drive `pithy vector provision`'s real `run` to completion, from inside the fixture project. */
async function runProvision(args: Record<string, unknown>): Promise<Run> {
  const entry = (vector.subCommands as Record<string, CommandDef>).provision;
  if (!entry) throw new Error("expected a provision subcommand on pithy vector");

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

/** The credentials every run here supplies. Nothing reaches Cloudflare; the provisioner is stubbed. */
function stubCredentials(): void {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-acme");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-acme");
}

describe("pithy vector provision reads and writes the app worker's wrangler.jsonc", () => {
  beforeAll(async () => {
    const built = await scaffoldedProject("pithy-vector-routing-");
    await provisionEnvironment(built.workerDir, "staging", "db-staging");
    fixture.dir = built.dir;
    fixture.workerDir = built.workerDir;
  });

  beforeEach(() => {
    recorded.envs = [];
    scope.workers = vectorWorkers(fixture.workerDir);
    stubCredentials();
  });

  /**
   * The guard on the fixture. Everything below is only worth running against a project shaped like the one
   * `pithy init` produces, and the defect was a read of a file that shape does not have — so the absence is
   * asserted rather than assumed.
   */
  test("the fixture is a project pithy init produces: no root wrangler.jsonc, one under apps/", () => {
    expect(existsSync(join(fixture.dir, "wrangler.jsonc"))).toBe(false);
    expect(existsSync(join(fixture.dir, "apps", WORKER, "wrangler.jsonc"))).toBe(true);
  });

  test("a run provisions the environment and writes nothing to the project root", async () => {
    const run = await runProvision({ env: "staging", json: true });

    expect(run.exitCode).toBeUndefined();
    expect(recorded.envs).toEqual(["staging"]);
    // Reading the root file was the defect; *creating* it would be the same defect wearing a write.
    expect(existsSync(join(fixture.dir, "wrangler.jsonc"))).toBe(false);
  });

  /**
   * The `VECTOR_PROVISIONED` record is the Worker's boot check — the only way an adopter who edits a
   * metadata schema and redeploys hears about the drift, since Vectorize answers such a filter with partial
   * results and no error. Written to the project root it lands in a file nothing loads, so the check would
   * never see a value at all.
   */
  test("the VECTOR_PROVISIONED record lands in the worker's own stanza", async () => {
    await runProvision({ env: "staging", json: true });

    const staging = await stanza(fixture.workerDir, "staging");
    const record = JSON.parse(staging.vars?.VECTOR_PROVISIONED ?? "null") as {
      indexes: Record<string, { indexName: string; metadataIndexes: { propertyName: string }[] }>;
    };
    expect(record.indexes.docs?.indexName).toBe(`${PROJECT}-staging-vector-docs`);
    expect(record.indexes.docs?.metadataIndexes.map((entry) => entry.propertyName)).toEqual(["ownerId"]);
  });

  /**
   * The bindings, for the same reason and with a sharper edge: `pithy add vector` cannot write them —
   * wrangler requires an `index_name` on a `vectorize` entry and a `name` plus `class_name` on a
   * `workflows` entry, and all three are provisioning outputs — so this command is the only thing that ever
   * completes them. Written to the root, the deployed Worker gets neither.
   */
  test("the vectorize and workflows bindings land in the worker's own stanza", async () => {
    await runProvision({ env: "staging", json: true });

    const staging = await stanza(fixture.workerDir, "staging");
    expect(staging.vectorize).toEqual([
      { binding: "VECTORIZE", index_name: `${PROJECT}-staging-vector-docs`, remote: true },
    ]);
    expect(staging.workflows?.map((entry) => entry.name)).toEqual([`${PROJECT}-staging-vector-reprocess`]);
  });

  /**
   * The refusal, which is the shape it kept: `vector` takes a required `--env`, so there is one environment
   * for it to be about and nothing to skip past. What changed is where the answer is read from and how a
   * missing file arrives — a `PithyError` naming the Worker, not a raw `ENOENT` stack.
   */
  test("an environment with no DB id is refused, by the worker's name", async () => {
    const run = await runProvision({ env: "prod", json: true });

    expect(run.exitCode).toBe(1);
    const failure = JSON.parse(run.stderr) as { error: { code: string; message: string } };
    expect(failure.error.code).toBe("validation/invalid_input");
    expect(failure.error.message).toBe(`${WORKER}'s wrangler.jsonc has no DB database_id for prod.`);
  });
});
