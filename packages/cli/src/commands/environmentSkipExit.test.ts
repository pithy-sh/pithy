// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { email as emailCapability } from "@pithy-sh/email/src/capability";
import { media as mediaCapability } from "@pithy-sh/media/src/capability";
import { payments as paymentsCapability } from "@pithy-sh/payments/src/capability";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { storage as storageCapability } from "@pithy-sh/storage/src/capability";
import { support as supportCapability } from "@pithy-sh/support/src/capability";
import { testers as testersCapability } from "@pithy-sh/testers/src/capability";
import type { CommandDef } from "citty";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { scaffoldProject } from "../project/scaffold";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { linkKitPackages } from "../test-utils/linkKit";

/**
 * **Requirement 4 of pithy-sh/pithy#512, driven rather than grepped: a run in which every environment was
 * skipped exits non-zero, and says which environments and why.**
 *
 * Skip-and-report replaced a mid-fan-out throw with a skip, and the failure mode it would otherwise
 * introduce is the one this file exists to close — a command that provisions nothing at all, prints
 * `Done.`, and exits 0. `ci/environmentSkips.test.ts` holds the *set* property (one rule, one expression of
 * it) and can only ever be a source scan; this holds the *behavior*, and it holds it by running the real
 * `run` of the real citty subcommand against a project the **real scaffolder** just built on disk. Deleting
 * the `requireReadyEnvironments` call from any of the six turns this file red.
 *
 * **The project is scaffolded, never written out here.** See {@link scaffoldedProject}: a fixture shaped to
 * make the code under test pass is a fixture that certifies whatever it was shaped around, and this file
 * spent its first version doing exactly that.
 *
 * **The command set is read off the commands directory, not written down here.** A seventh command that
 * grows this shape is enrolled by the act of importing the readiness helper, and arrives here with no
 * fixture — which fails, by name, with the line that says what to add. A list maintained by hand is how
 * the seventh copy stays invisible.
 *
 * Everything that would touch Cloudflare is replaced and nothing else is: the project's config, its
 * Workers, and each capability's live provisioner. The command body, the readiness partition, the
 * orchestrator, the report and the exit are all the real ones — including the project-global resources the
 * orchestrators still create when every environment skips, which the recorder below asserts.
 */

/** `packages/cli/src/commands` — the directory the fan-out set is enumerated from. */
const COMMANDS = dirname(fileURLToPath(import.meta.url));

/**
 * Every command that decides readiness through the shared helper, read off disk at collection time.
 *
 * The import is the enrollment: a command consulting {@link environmentReadiness} is a command that fans
 * out across environments, and every one of them must exit non-zero when nothing was ready.
 */
function fanOutCommands(): string[] {
  return readdirSync(COMMANDS)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) => readFileSync(join(COMMANDS, file), "utf8").includes('from "../project/environmentReadiness"'))
    .map((file) => file.replace(/\.ts$/, ""))
    .sort();
}

/** The project name and first Worker every fixture below is scaffolded with. */
const PROJECT = "acme";
const WORKER = "api";

/**
 * The project root, the app Worker's directory, and the Workers the command resolves — one per run.
 *
 * **Two directories, because a real project has two.** `dir` is the project root and holds no
 * `wrangler.jsonc` at all; the only one is `apps/api/wrangler.jsonc`, which is `workerDir`. Collapsing them
 * is what let four of the six commands read a file no project has and still pass this file (#512).
 */
const fixture = vi.hoisted(() => ({ dir: "", workerDir: "" }));

/**
 * What the stubbed provisioners were asked to do, each entry qualified by the environment it was for — see
 * {@link step}. A project-global step is unqualified; a step for a **skipped** environment must not appear
 * at all.
 */
const recorded = vi.hoisted(() => ({ calls: [] as string[] }));

/** The project's Workers, carrying every capability the six commands look for. */
const scope = vi.hoisted(() => ({ workers: [] as unknown[] }));

// The audit emitter reaches Cloudflare (and rescans `apps/`) the moment credentials resolve, and these runs
// supply credentials on purpose. Nothing here is about auditing.
vi.mock("../audit/cliAudit", () => ({ createProjectCliAudit: async () => async () => {} }));

// Capabilities are per Worker and there is no `apps/` under the test runner's cwd, so the set is supplied.
// `projectCapabilities` and `composedProjectCapabilities` stay real — they are what each command reads.
vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveWorkers: async () => scope.workers,
  resolveSingleWorker: async () => scope.workers[0],
}));

// Only the root config is stubbed. `requireProjectName` and `loadProjectEnvironments` stay real, so the
// declaration this run fans out across is the one a project would actually get — and the values here are
// held to the scaffolded `pithy.config.ts` by a case below, so the stub cannot drift from what `pithy init`
// writes.
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: PROJECT, environments: ["staging", "prod"] }),
  projectCloudflareAccount: async () => null,
}));

/**
 * One stubbed provisioner step: record that it happened **and which environment it happened to**, then hand
 * back the shape the orchestrator reads.
 *
 * The environment is part of the record because it is the question. "Nothing was created for production"
 * cannot be asked of a log that only says `media:bucket`, and the version of this file that recorded bare
 * step names could only ever filter the log by a chosen suffix — `:deployWorker` and `:credentials` — which
 * left a bucket, a namespace, a secret or a search index created for a skipped environment unnoticed. A
 * project-global step passes `null` and stays unqualified.
 */
function step<T>(name: string, env: ManagedEnvironment | null, value: T): T {
  recorded.calls.push(env === null ? name : `${name}:${env}`);
  return value;
}

/** Every step this run took **for one environment** — whatever the capability, whatever the step. */
function stepsFor(env: ManagedEnvironment): string[] {
  return recorded.calls.filter((call) => call.endsWith(`:${env}`));
}

// The six live provisioners, replaced class by class. `loadMedia`, `loadStorage`, `loadSupport`,
// `loadPayments` and `loadTestersProvisioning` stay real, so the orchestration each command drives — and
// the project-global resources it creates over an empty environment list — is the shipped one.
vi.mock("../capabilities/emailProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/emailProvisioner")>()),
  CloudflareEmailProvisioner: class {
    async preflight() {}
    async ensureSuppressionDatabase() {
      return step("email:suppressionDatabase", null, { databaseId: "sup-db", created: true });
    }
    async migrateSuppression() {
      return step("email:migrateSuppression", null, undefined);
    }
    async deployWorker(env: ManagedEnvironment) {
      return step("email:deployWorker", env, undefined);
    }
    async ensureRoutingRule() {
      return step("email:routingRule", null, { created: true, skipped: false });
    }
  },
}));

vi.mock("../capabilities/mediaProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/mediaProvisioner")>()),
  CloudflareMediaProvisioner: class {
    async preflight() {}
    async ensureBucket(env: ManagedEnvironment) {
      return step("media:bucket", env, { bucketName: `acme-${env}-media`, created: true });
    }
    async ensureKvNamespace(env: ManagedEnvironment) {
      return step("media:kv", env, null);
    }
    async writeCredentials(env: ManagedEnvironment) {
      return step("media:credentials", env, undefined);
    }
    async deployWorker(env: ManagedEnvironment) {
      return step("media:deployWorker", env, undefined);
    }
  },
}));

vi.mock("../capabilities/paymentsProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/paymentsProvisioner")>()),
  CloudflarePaymentsProvisioner: class {
    async preflight() {}
    async deployWorker(env: ManagedEnvironment) {
      return step("payments:deployWorker", env, undefined);
    }
  },
}));

vi.mock("../capabilities/storageProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/storageProvisioner")>()),
  CloudflareStorageProvisioner: class {
    async preflight() {}
    async ensureBucket(env: ManagedEnvironment) {
      return step("storage:bucket", env, { bucketName: `acme-${env}-storage`, created: true });
    }
    async writeCredentials(env: ManagedEnvironment) {
      return step("storage:credentials", env, undefined);
    }
    async deployWorker(env: ManagedEnvironment) {
      return step("storage:deployWorker", env, undefined);
    }
  },
}));

vi.mock("../capabilities/supportProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/supportProvisioner")>()),
  CloudflareSupportProvisioner: class {
    async preflight() {}
    async ensureBucket() {
      return step("support:bucket", null, { bucket: "acme-global-support", created: true, skipped: false });
    }
    async deployWorker(env: ManagedEnvironment) {
      return step("support:deployWorker", env, undefined);
    }
    async ensureSearchIndex(env: ManagedEnvironment) {
      return step("support:searchIndex", env, { created: false, dropped: false });
    }
    async ensureRoutingRule() {
      return step("support:routingRule", null, { created: true, skipped: false });
    }
  },
}));

vi.mock("../capabilities/testersProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/testersProvisioner")>()),
  CloudflareTestersProvisioner: class {
    async preflight() {}
    async deployWorker(env: ManagedEnvironment) {
      return step("testers:deployWorker", env, undefined);
    }
  },
}));

/**
 * A project's Workers, as the commands resolve them: one Worker composing everything the six look for.
 *
 * `dir` is `apps/<worker>`, never the project root — that is the whole point. Every command here must reach
 * its `wrangler.jsonc` through the Worker it resolved, and a command still reading the root finds nothing.
 */
function projectWorkers(dir: string): unknown[] {
  return [
    {
      name: WORKER,
      dir,
      config: {},
      capabilities: [
        emailCapability({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" }),
        mediaCapability(),
        storageCapability(),
        supportCapability(),
        testersCapability(),
        paymentsCapability({
          billingSubject: "user",
          rails: { lemonSqueezy: true },
          lemonSqueezy: { successUrl: "https://app.acme.test/thanks" },
          products: {
            pro: { type: "subscription", name: "Pro", entitlements: ["pro"], lemonSqueezy: { variantId: "1" } },
          },
        }),
      ],
      target: {},
    },
  ];
}

/**
 * A project built the way `pithy init` builds one — **by the real scaffolder, not by a literal here**.
 *
 * This is the correction that made the rest of the file mean anything. The fixture used to write a
 * `wrangler.jsonc` at the project root, and a scaffolded project has none: the root carries identity and
 * policy, and every deployable Worker lives in `apps/<name>/` with its own config (CLAUDE.md §CLI, and
 * `project/scaffold.test.ts` asserts the root file's absence by name). Four of the six commands read
 * `<root>/wrangler.jsonc` and died before reaching the partition, the skip, the report or the exit code —
 * and passed every case below, because the fixture wrote the file they were looking for. A fixture built to
 * satisfy the code under test certifies exactly what it was shaped around.
 *
 * The scaffolder is also what makes the unprovisioned state honest: `apps/api/wrangler.jsonc` ships
 * `"d1_databases": []` in both environment stanzas, so *nothing is provisioned yet* is the state a project
 * is in the minute it is created, rather than one this file invents.
 */
async function scaffoldedProject(prefix: string): Promise<{ dir: string; workerDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await scaffoldProject({ targetDir: dir, appName: PROJECT, worker: WORKER });
  // The capabilities this fixture composes, installed the way a real project installs them. Since #533 the
  // CLI resolves them from the project rather than from its own location, so a fixture with an empty
  // `node_modules` is a project with nothing added.
  await linkKitPackages(dir, ["media", "payments", "storage", "support", "testers", "email"]);
  return { dir, workerDir: join(dir, "apps", WORKER) };
}

/** One environment stanza in the app Worker's `wrangler.jsonc`. */
interface Stanza {
  d1_databases?: { binding: string; database_id?: string }[];
}

/**
 * The **exact bytes** of one environment's stanza in the app Worker's `wrangler.jsonc` — from its key to
 * the brace that closes it.
 *
 * Bytes rather than a parsed shape, and a slice of the file rather than a re-serialization, because the
 * property this measures is *nothing about this environment changed* and any projection of the stanza can
 * only answer for the keys the projection thought to look at. That is exactly how the write half of "a
 * skipped environment is untouched" went unasserted: every case here checked that no **resource** was
 * created for a skipped environment, and none checked that no **binding** was written into its stanza. A
 * `workflows` entry written into `env.prod` — `payments`' reconcile Workflow is the live case, and
 * `storage`'s sweep and `testers`' daily are the same shape — was invisible to the entire CLI suite: the
 * fan-out already skips production, so nothing was recorded, and no assertion looked at the file.
 *
 * The walk tracks strings so a `}` inside one does not close the stanza early, and the key is matched with
 * its colon so the `"prod"` in `"ENVIRONMENT": "prod"` cannot be mistaken for the stanza that holds it.
 */
function stanzaBytes(workerDir: string, env: ManagedEnvironment): string {
  const text = readFileSync(join(workerDir, "wrangler.jsonc"), "utf8");
  const key = new RegExp(`"${env}"\\s*:`).exec(text);
  if (!key) throw new Error(`the scaffolded ${WORKER} worker has no env.${env} stanza`);
  const open = text.indexOf("{", key.index);
  if (open === -1) throw new Error(`the env.${env} stanza has no body`);

  let depth = 0;
  let inString = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return text.slice(key.index, index + 1);
  }
  throw new Error(`the env.${env} stanza is unterminated`);
}

/** Read the app Worker's `wrangler.jsonc`, hand its stanzas to `edit`, and write it back. */
async function editStanzas(workerDir: string, edit: (stanzas: Record<string, Stanza>) => void): Promise<void> {
  const config = (await readWranglerConfig(workerDir)) as { env?: Record<string, Stanza> };
  const stanzas = config.env;
  if (!stanzas) throw new Error(`the scaffolded ${WORKER} worker has no env stanzas`);
  edit(stanzas);
  await writeWranglerConfig(workerDir, config);
}

/**
 * Leave one environment in the state a **half-finished** `pithy provision` leaves: a `DB` binding whose
 * `database_id` is the empty string.
 *
 * Kept because it is the shape a truthiness check reads differently from an absent key, and both are
 * unprovisioned. A readiness check that saw only one of them would provision the other and report it
 * deployed — a Worker bound to a database that is not there, announced as a success.
 */
async function halfProvisionEnvironment(workerDir: string, env: ManagedEnvironment): Promise<void> {
  await editStanzas(workerDir, (stanzas) => {
    const stanza = stanzas[env];
    if (!stanza) throw new Error(`the scaffolded ${WORKER} worker has no env.${env} stanza`);
    stanza.d1_databases = [{ binding: "DB", database_id: "" }];
  });
}

/** Put one environment in the state `pithy provision --env <name>` leaves: a `DB` binding with a real id. */
async function provisionEnvironment(workerDir: string, env: ManagedEnvironment, databaseId: string): Promise<void> {
  await editStanzas(workerDir, (stanzas) => {
    const stanza = stanzas[env];
    if (!stanza) throw new Error(`the scaffolded ${WORKER} worker has no env.${env} stanza`);
    stanza.d1_databases = [{ binding: "DB", database_id: databaseId }];
  });
}

/**
 * How each fan-out command is reached: its module, and the flags its `provision` takes beyond `--json`.
 *
 * Keyed by the same names {@link fanOutCommands} reads off disk, and a command missing from here fails by
 * name rather than being quietly untested — which is the whole reason the set is enumerated rather than
 * written out. Static importers, because a templated `import()` is a bundler variable-import.
 */
const FIXTURES: Record<string, { load: () => Promise<{ default: CommandDef }>; args: Record<string, unknown> }> = {
  email: { load: () => import("./email"), args: {} },
  media: { load: () => import("./media"), args: {} },
  payments: { load: () => import("./payments"), args: {} },
  storage: { load: () => import("./storage"), args: {} },
  support: { load: () => import("./support"), args: {} },
  testers: { load: () => import("./testers"), args: {} },
};

/** What each command wrote to stdout and stderr, and the code it exited with. */
interface Run {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

/** Drive one command's real `provision` subcommand to completion, from inside the fixture project. */
async function runProvision(command: string, json: boolean): Promise<Run> {
  const fixtureFor = FIXTURES[command];
  if (!fixtureFor) {
    throw new Error(
      `pithy ${command} consults environmentReadiness and has no fixture here. Add one to FIXTURES: this file is what proves a run with every environment skipped exits non-zero.`,
    );
  }
  const module = await fixtureFor.load();
  const entry = (module.default.subCommands as Record<string, CommandDef>).provision;
  if (!entry) throw new Error(`expected a provision subcommand on pithy ${command}`);
  const args = fixtureFor.args;

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
  // `withErrorReporting` exits the process after reporting; throwing instead keeps the run in this test,
  // and the code it was called with is the whole assertion.
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error("exited");
  }) as never);
  try {
    await entry.run?.({ args: { ...args, json }, rawArgs: [] } as never);
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

/** The credentials every run here supplies. Nothing reaches Cloudflare; the provisioners are stubbed. */
function stubCredentials(): void {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-acme");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-acme");
  vi.stubEnv("SECRETS_STORE_ID", "store-acme");
  vi.stubEnv("R2_CREDENTIALS", JSON.stringify({ accessKeyId: "ak", secretAccessKey: "sk" }));
}

describe("a run in which every environment was skipped", () => {
  beforeAll(async () => {
    const built = await scaffoldedProject("pithy-skip-exit-");
    // Both environments unprovisioned, in the two shapes a real project reaches: `staging` as the
    // scaffolder leaves it (`"d1_databases": []`), `prod` as a half-finished provision leaves it.
    await halfProvisionEnvironment(built.workerDir, "prod");
    fixture.dir = built.dir;
    fixture.workerDir = built.workerDir;
  });

  beforeEach(() => {
    recorded.calls = [];
    scope.workers = projectWorkers(fixture.workerDir);
    stubCredentials();
  });

  /**
   * The guard on the fixture itself. Everything below is only worth running against a project shaped like
   * the one `pithy init` produces, and the way this file was wrong for four of six commands was a root
   * `wrangler.jsonc` that no project has — so the absence is asserted rather than assumed.
   */
  test("the fixture is a project pithy init produces: no root wrangler.jsonc, one under apps/", () => {
    expect(existsSync(join(fixture.dir, "wrangler.jsonc"))).toBe(false);
    expect(existsSync(join(fixture.dir, "apps", WORKER, "wrangler.jsonc"))).toBe(true);
    // The stubbed `loadProject` stands in for this file. If the scaffolder's identity or its declared
    // environments ever move, the stub is a lie and this is where that is heard.
    const config = readFileSync(join(fixture.dir, "pithy.config.ts"), "utf8");
    expect(config).toContain(`name: "${PROJECT}"`);
    const wrangler = readFileSync(join(fixture.dir, "apps", WORKER, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"staging"');
    expect(wrangler).toContain('"prod"');
  });

  test("the fan-out set is read off the commands directory, and it is the six", () => {
    // Not an inventory for its own sake: this is what makes every case below close over a *seventh*
    // command rather than over a list somebody remembered to extend.
    expect(fanOutCommands()).toEqual(["email", "media", "payments", "storage", "support", "testers"]);
  });

  test.each(fanOutCommands())("pithy %s provision exits 1 and names every skipped environment", async (command) => {
    const run = await runProvision(command, false);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(
      "  staging  skipped — env.staging has no DB database_id. Run pithy provision --env staging.",
    );
    expect(run.stdout).toContain(
      "  prod     skipped — env.prod has no DB database_id. Run pithy provision --env prod.",
    );
    // A run that did nothing must never read as one that did something.
    expect(run.stdout).not.toContain("Done.");
    expect(run.stderr).toContain("No environment is ready — staging and prod have no DB database_id.");
    expect(run.stderr).toContain(
      `Run pithy provision --env staging to create its app database, then run pithy ${command} provision again.`,
    );
  });

  test.each(fanOutCommands())(
    "pithy %s provision --json carries the skips on stdout and the error on stderr",
    async (command) => {
      const run = await runProvision(command, true);

      expect(run.exitCode).toBe(1);
      const report = JSON.parse(run.stdout) as { command: string; skippedEnvironments: { env: string }[] };
      expect(report.command).toBe(`${command} provision`);
      // Per-environment structure, not one aggregate — the report must answer "did production get its worker".
      expect(report.skippedEnvironments.map((entry) => entry.env)).toEqual(["staging", "prod"]);
      const failure = JSON.parse(run.stderr) as { error: { code: string; message: string } };
      expect(failure.error.code).toBe("validation/invalid_input");
      expect(failure.error.message).toBe("No environment is ready — staging and prod have no DB database_id.");
    },
  );

  test.each(fanOutCommands())("pithy %s provision creates nothing for a skipped environment", async (command) => {
    await runProvision(command, false);

    // **Everything** recorded for each environment, not two chosen steps. Filtering on `:deployWorker` and
    // `:credentials` was the version of this case that let a bucket, a KV namespace, a search index or a
    // secret be created for a skipped environment and still read as clean — and creating those is the
    // failure the whole issue is about, since it is what a half-finished fan-out leaves behind.
    expect(stepsFor("staging")).toEqual([]);
    expect(stepsFor("prod")).toEqual([]);
  });

  /**
   * Requirement 3, at the command level rather than at the orchestrator's: the project-global resource is
   * created on the first run however many environments skip. It must not wait for prod.
   */
  test("email provision still creates the suppression database, and makes no routing rule", async () => {
    await runProvision("email", false);

    expect(recorded.calls).toEqual(["email:suppressionDatabase", "email:migrateSuppression"]);
  });

  test("support provision still creates the bucket, and makes no routing rule", async () => {
    await runProvision("support", false);

    expect(recorded.calls).toEqual(["support:bucket"]);
  });
});

/**
 * The other half of requirement 4: **one ready environment is a success.** Without this the exit-code rule
 * above is satisfiable by a command that always exits non-zero, which would be the same defect wearing the
 * opposite sign — a staging-only bring-up failing after it worked.
 */
describe("a run in which one environment was ready", () => {
  beforeAll(async () => {
    const built = await scaffoldedProject("pithy-skip-exit-ready-");
    // Exactly what `pithy provision --env staging` leaves, and nothing more: staging has an app database
    // and production has never been provisioned. This is the bring-up #512 is about.
    await provisionEnvironment(built.workerDir, "staging", "db-staging");
    fixture.dir = built.dir;
    fixture.workerDir = built.workerDir;
  });

  beforeEach(() => {
    recorded.calls = [];
    scope.workers = projectWorkers(fixture.workerDir);
    stubCredentials();
  });

  /**
   * **The property #512 is actually about**, and nothing asserted it: a skipped environment is left
   * untouched *while another is provisioned*. The all-skipped cases above cannot say this — a command that
   * refuses the moment anything is unready satisfies every one of them — and the exit-code rule cannot
   * either, since "always non-zero" would pass that too.
   *
   * It runs for all six rather than for `support` alone, which is what turned four commands' `workerDir:
   * projectDir` from an invisible defect into a red test: reading a file no project has fails before the
   * partition, so a command that never reaches the skip cannot pass this.
   */
  test.each(fanOutCommands())("pithy %s provision provisions staging, touches prod not at all", async (command) => {
    const run = await runProvision(command, false);

    expect(run.exitCode).toBeUndefined();
    expect(run.stdout).toContain(
      "  prod     skipped — env.prod has no DB database_id. Run pithy provision --env prod.",
    );
    expect(run.stdout).toContain("Done.");
    // Not a chosen step or two: **every** step this run took for production, which must be none of them.
    expect(stepsFor("prod")).toEqual([]);
    // And the other half, so the case cannot be satisfied by a command that provisioned nothing at all.
    expect(stepsFor("staging").length).toBeGreaterThan(0);
  });

  test.each(fanOutCommands())("pithy %s provision --json reports prod skipped and exits 0", async (command) => {
    const run = await runProvision(command, true);

    expect(run.exitCode).toBeUndefined();
    const report = JSON.parse(run.stdout) as { command: string; skippedEnvironments: { env: string }[] };
    expect(report.command).toBe(`${command} provision`);
    expect(report.skippedEnvironments.map((entry) => entry.env)).toEqual(["prod"]);
    expect(run.stderr).toBe("");
  });

  test("support provision deploys staging and makes the routing rule", async () => {
    const run = await runProvision("support", false);

    expect(run.stdout).toContain("  staging  classification worker deployed");
    expect(recorded.calls).toContain("support:deployWorker:staging");
    // The rule is made now, because a classification host is up to receive what it delivers.
    expect(recorded.calls).toContain("support:routingRule");
  });

  test("email provision deploys staging and makes the routing rule", async () => {
    await runProvision("email", false);

    expect(recorded.calls).toContain("email:deployWorker:staging");
    expect(recorded.calls).toContain("email:routingRule");
  });
});

/**
 * **The write half of "a skipped environment is untouched", which nothing asserted.**
 *
 * Every case above measures a skipped environment by what was *created* for it — the recorder holds one
 * entry per provisioner step, qualified by environment, and asserts production has none. That is only half
 * of what a capability provisioning run produces. Four of the six also write into the app Worker's
 * `wrangler.jsonc`: `payments`' reconcile Workflow binding, `storage`'s sweep, `testers`' daily,
 * `vector`'s index bindings. A `workflows` entry landing in `env.prod` was invisible to the entire CLI
 * suite — the recorder sees nothing, because no provisioner step ran; the report reads correctly, because
 * prod really is listed as skipped; the exit code is 0. And the next `pithy deploy --env prod` fails on a
 * Workflow that does not exist, or worse, boots against a binding nothing backs.
 *
 * So the assertion is **byte-identical**, not "has no new binding". A named-key check can only fail on the
 * key whoever wrote it thought of, and the whole reason this gap existed is that nobody thought of this
 * one. Bytes cannot miss a write nobody looked for.
 *
 * **A fresh project per case, which is what makes the assertion able to fail.** The first version of this
 * lived in the describe above and shared its fixture, and a planted write into `env.prod` passed it: an
 * earlier case had already run the same command against the same file, the write is idempotent, and
 * `before` was therefore read *after* the pollution it was meant to catch. Sharing a mutable fixture
 * across cases is exactly how a before/after comparison certifies the state it was supposed to reject.
 */
describe("a skipped environment's stanza after a run", () => {
  beforeEach(async () => {
    // Exactly what `pithy provision --env staging` leaves: staging has an app database, production has
    // never been provisioned. Rebuilt per case, so `before` is the file as an operator's bring-up left it.
    const built = await scaffoldedProject("pithy-skip-untouched-");
    await provisionEnvironment(built.workerDir, "staging", "db-staging");
    fixture.dir = built.dir;
    fixture.workerDir = built.workerDir;
    recorded.calls = [];
    scope.workers = projectWorkers(fixture.workerDir);
    stubCredentials();
  });

  test.each(fanOutCommands())("pithy %s provision writes nothing into prod's stanza", async (command) => {
    const before = stanzaBytes(fixture.workerDir, "prod");

    const run = await runProvision(command, false);

    // The run succeeded and provisioned staging — otherwise an untouched prod proves nothing.
    expect(run.exitCode).toBeUndefined();
    expect(stepsFor("staging").length).toBeGreaterThan(0);
    expect(stanzaBytes(fixture.workerDir, "prod")).toBe(before);
  });
});
