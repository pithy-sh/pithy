// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Plan, type PlanMigration } from "../plan/plan";
import { scaffoldProject } from "../project/scaffold";
import { EXIT } from "../terminal/exitClass";
import { recorder } from "../test-utils/cloudflareRecorder";
import { linkKitPackages } from "../test-utils/linkKit";
import { captureStdout, commandAt, expectConforms, runCaptured } from "../test-utils/payloadContract";
import { removeTempDir } from "../test-utils/tempRepo";
import { snapshotTree } from "../test-utils/treeSnapshot";

/**
 * **`pithy deploy --dry-run` reports Pithy's plan, then runs `wrangler deploy --dry-run`, and uploads nothing
 * (#697)** — the real command, in a scaffolded project. Two seams are replaced, and only to observe them: the
 * Cloudflare clients, by one that answers reads and records every write, and the wrangler spawn, by one that
 * records each argv in the order it was asked. The migration read is replaced by a list, because what it reads
 * is `migrations/dryRun.test.ts`'s subject; here it is asked when, and what the plan says about its answer.
 *
 * The build and the wrangler argv are `project/deploy.test.ts`'s; the plan's assembly is `deployPlan.test.ts`'s.
 */

const cloudflare = vi.hoisted(() => ({ current: undefined as unknown as { clients: () => Promise<unknown> } }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: () => cloudflare.current.clients(),
}));

/** Everything the run asked for, in order: the migration read, then each wrangler argv. */
const observed = vi.hoisted(() => ({
  order: [] as string[],
  pending: [] as PlanMigration[],
  wrangler: undefined as ((args: string[]) => Promise<{ stdout: string; stderr: string }>) | undefined,
}));

vi.mock("../migrations/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../migrations/run")>()),
  planMigrateProject: async () => {
    observed.order.push("migrations");
    return observed.pending;
  },
}));

vi.mock("../project/wrangler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/wrangler")>()),
  runWrangler: async (args: string[]) => {
    observed.order.push(`wrangler ${args.join(" ")}`);
    return observed.wrangler ? observed.wrangler(args) : { stdout: "--dry-run: exiting now.", stderr: "" };
  },
}));

const PENDING: PlanMigration = {
  env: "staging",
  worker: "api",
  database: "app",
  binding: "DB",
  name: "1000_app_0001_things",
  direction: "up",
};

let dir: string;
let account: ReturnType<typeof recorder>;

beforeEach(async () => {
  account = recorder();
  cloudflare.current = account;
  observed.order = [];
  observed.pending = [];
  observed.wrangler = undefined;
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
  vi.stubEnv("CLOUDFLARE_ENV", "");
  dir = await mkdtemp(join(tmpdir(), "pithy-deploy-dry-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
  // The origin a staging deploy refuses without (#253), so the one refusal a case varies is its own.
  await editStaging('"WORKER": "api"', '"WORKER": "api",\n        "BASE_URL": "https://staging.acme.example"');
  await editStaging(
    '"version_metadata"',
    '"workers_dev": false,\n      "routes": [{ "pattern": "staging.acme.example", "custom_domain": true }],\n      "version_metadata"',
  );
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await removeTempDir(dir);
});

/** Replace the first `from` inside the scaffolded Worker's staging stanza with `to`. */
async function editStaging(from: string, to: string): Promise<void> {
  const path = join(dir, "apps", "api", "wrangler.jsonc");
  const text = await readFile(path, "utf8");
  const at = text.indexOf(from, text.indexOf('"staging"'));
  await writeFile(path, `${text.slice(0, at)}${to}${text.slice(at + from.length)}`);
}

/** Give the scaffolded Worker's staging stanza a D1 binding, with an id or without one. */
async function bindStagingDatabase(id?: string): Promise<void> {
  const binding = { binding: "DB", database_name: "acme-staging-db", ...(id === undefined ? {} : { database_id: id }) };
  await editStaging('"d1_databases": []', `"d1_databases": [${JSON.stringify(binding)}]`);
}

describe("pithy deploy --env staging --dry-run", () => {
  test("--json: Pithy's plan, then wrangler with --dry-run, nothing written and nothing uploaded", async () => {
    observed.pending = [PENDING];
    const before = await snapshotTree(dir);

    const written = await runCaptured("deploy", ["--env", "staging", "--dry-run", "--json"]);

    await expectConforms("deploy", written);
    const payload = JSON.parse(written.join(""));
    expect(payload).toMatchObject({ command: "deploy", env: "staging", dryRun: true, pendingMigrations: 1 });
    expect(payload.workers).toEqual([{ name: "acme-api", ok: true }]);
    const plan = Plan.parse(payload.plan);
    expect(plan.resources).toEqual([{ kind: "worker", name: "acme-api", env: "staging", action: "upload" }]);
    expect(plan.migrations).toEqual([]);
    expect(plan.notes).toEqual([
      "1 migration unapplied for staging: 1000_app_0001_things. Deploy does not migrate — run pithy migrate --env staging.",
    ]);
    // Pithy's plan first, then wrangler — and every wrangler it ran was a dry run.
    expect(observed.order).toEqual([
      "migrations",
      "wrangler deploy --env staging --experimental-provision=false --dry-run",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(await snapshotTree(dir)).toEqual(before);
    expect(account.writes).toEqual([]);
  });

  test("a bundle that does not build fails the dry run with wrangler's error, and plans no upload for it", async () => {
    observed.wrangler = async () => {
      throw new InternalError({ message: "wrangler deploy failed.", detail: 'X [ERROR] Could not resolve "./gone"' });
    };

    const written = await runCaptured("deploy", ["--env", "staging", "--dry-run", "--json"]);

    await expectConforms("deploy", written);
    const payload = JSON.parse(written.join(""));
    expect(payload.workers).toEqual([{ name: "acme-api", ok: false, error: 'X [ERROR] Could not resolve "./gone"' }]);
    expect(Plan.parse(payload.plan).resources).toEqual([]);
    expect(process.exitCode).toBe(EXIT.failed);
    expect(account.writes).toEqual([]);
  });

  /**
   * **A dry run makes the refusal the real run makes (#697).** A binding with no id is a deploy that would not
   * happen, so a plan of it would be a promise nobody can keep. Under `--json` the answer is the one error line a
   * refused run writes, on stderr, carrying its exit class and the command that rights it — never a success-shaped
   * document on stdout beside an exit 3 nobody explained. Refused before anything is built, as the run is.
   */
  test("a binding with no id is the deploy's own refusal: one error line, exit 3, the fix, and no plan", async () => {
    await bindStagingDatabase();
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => out.push(String(chunk)) > 0) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => err.push(String(chunk)) > 0) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);

    await runCommand(await commandAt("deploy"), { rawArgs: ["--env", "staging", "--dry-run", "--json"] }).catch(
      () => undefined,
    );

    expect(out).toEqual([]);
    const lines = err.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).error).toMatchObject({
      code: "core/precondition_failed",
      message: "staging declares bindings with no Cloudflare resource behind them: api.DB (d1).",
      exit: EXIT.precondition,
      retryable: false,
      fix: "pithy provision --env staging --yes",
    });
    expect(exit).toHaveBeenCalledWith(EXIT.precondition);
    expect(observed.order).toEqual([]);
    expect(account.writes).toEqual([]);
  });

  test("a provisioned binding is no refusal", async () => {
    await bindStagingDatabase("0f6ad3f8-6a9e-4bd4-9d3a-2f4f0c1f1a11");
    const written = await runCaptured("deploy", ["--env", "staging", "--dry-run", "--json"]);
    expect(Plan.parse(JSON.parse(written.join("")).plan).notes).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  test("text: each Worker settles as what would happen, then the plan, then the dry-run line", async () => {
    const before = await snapshotTree(dir);
    const written = captureStdout();
    await runCommand(await commandAt("deploy"), { rawArgs: ["--env", "staging", "--dry-run"] });
    const lines = written.join("").trimEnd().split("\n");
    expect(lines).toContain("acme-api: would deploy.");
    expect(lines).toContain("Would upload worker acme-api (staging).");
    expect(lines.at(-1)).toBe("Dry run. Nothing uploaded.");
    expect(lines).not.toContain("Done.");
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("the real deploy never adds --dry-run, and says so in its payload", async () => {
    const written = await runCaptured("deploy", ["--env", "staging", "--apps", "--json"]);
    expect(JSON.parse(written.join(""))).toMatchObject({ dryRun: false });
    expect(JSON.parse(written.join(""))).not.toHaveProperty("plan");
    expect(observed.order.filter((entry) => entry.startsWith("wrangler"))).toEqual([
      "wrangler deploy --env staging --experimental-provision=false",
    ]);
  });
});
