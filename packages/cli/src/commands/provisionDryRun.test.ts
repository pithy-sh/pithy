// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Plan } from "../plan/plan";
import { scaffoldProject } from "../project/scaffold";
import { EXIT, exitCodeOf } from "../terminal/exitClass";
import { recorder } from "../test-utils/cloudflareRecorder";
import { linkKitPackages } from "../test-utils/linkKit";
import { captureStdout, commandAt, expectConforms, runCaptured } from "../test-utils/payloadContract";
import { GIT_NO_MAINTENANCE, removeTempDir } from "../test-utils/tempRepo";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { runProvision } from "./provision";

/**
 * **`pithy provision --dry-run` creates nothing, writes nothing, and calls nothing that writes (#697)** — the
 * real command, in a scaffolded project whose app declares a database, with the Cloudflare clients replaced
 * by one that answers reads and records every write. The account holds nothing, so every resource is
 * planned as a creation and every migration as pending. Both modes: a declared environment, and a branch's.
 *
 * The planning itself is `provision/dryRun.test.ts`'s; this is the command around it.
 */

const cloudflare = vi.hoisted(() => ({ current: undefined as unknown as { clients: () => Promise<unknown> } }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: () => cloudflare.current.clients(),
}));

const run = promisify(execFile);

/** The app capability: one database, one migration, bound as `DB`. */
const APP_CONFIG = `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const app = defineCapability({
  name: "app",
  requiredBindings: [{ type: "d1", name: "DB" }],
  databases: {
    app: {
      binding: "DB",
      tables: {},
      migrations: {
        "0001_things": {
          up: async (db) => {
            await db.schema.createTable("things").addColumn("id", "integer").execute();
          },
          down: async (db) => {
            await db.schema.dropTable("things").execute();
          },
        },
      },
      migrationOrder: 1000,
    },
  },
});

export default { capabilities: [], app };
`;

let dir: string;
let account: ReturnType<typeof recorder>;

beforeEach(async () => {
  account = recorder();
  cloudflare.current = account;
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
  dir = await mkdtemp(join(tmpdir(), "pithy-provision-dry-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
  await writeFile(join(dir, "apps", "api", "pithy.config.ts"), APP_CONFIG);
  // The project claims the account, so a lookup that finds nothing is an answer rather than a refusal.
  const root = join(dir, "pithy.config.ts");
  await writeFile(
    root,
    (await readFile(root, "utf8")).replace(
      '// cloudflare: { accountName: "acme", accountId: "" },',
      'cloudflare: { accountId: "acct" },',
    ),
  );
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await removeTempDir(dir);
});

describe("pithy provision --env --dry-run", () => {
  test("--json: the published payload with its plan, nothing written, only reads made", async () => {
    const before = await snapshotTree(dir);
    const written = await runCaptured("provision", ["--env", "staging", "--dry-run", "--json"]);

    await expectConforms("provision", written);
    const payload = JSON.parse(written.join(""));
    expect(payload).toMatchObject({ command: "provision", env: "staging", dryRun: true });
    const plan = Plan.parse(payload.plan);
    expect(plan.resources).toEqual([
      { kind: "d1", name: "acme-staging-db", binding: "DB", env: "staging", action: "create" },
    ]);
    expect(plan.files.map((file) => [file.path, file.action])).toEqual([["apps/api/wrangler.jsonc", "edit"]]);
    expect(plan.migrations.map((migration) => [migration.env, migration.name, migration.direction])).toEqual([
      ["staging", "1000_app_0001_things", "up"],
    ]);
    expect(await snapshotTree(dir)).toEqual(before);
    expect(account.calls).toEqual(["d1Provisioner.findDatabaseByName"]);
    expect(account.writes).toEqual([]);
  });

  test("never asks for the production phrase, because nothing it plans needs one", async () => {
    const written = await runCaptured("provision", ["--env", "prod", "--dry-run", "--json"]);
    expect(JSON.parse(written.join(""))).toMatchObject({ env: "prod", dryRun: true });
    expect(account.writes).toEqual([]);
  });

  test("text: the plan, then the dry-run line in place of Done.", async () => {
    const before = await snapshotTree(dir);
    const written = captureStdout();
    await runCommand(await commandAt("provision"), { rawArgs: ["--env", "staging", "--dry-run"] });
    const lines = written.join("").trimEnd().split("\n");
    expect(lines).toContain("Would create d1 acme-staging-db (DB, staging).");
    expect(lines).toContain("Would apply 1000_app_0001_things to app (DB, staging).");
    expect(lines.at(-1)).toBe("Dry run. Nothing written.");
    expect(await snapshotTree(dir)).toEqual(before);
  });

  test("with a Secrets Store: the store is only asked, a mintable secret is planned as a mint, and nothing is written", async () => {
    vi.stubEnv("SECRETS_STORE_ID", "store-1");
    await linkKitPackages(dir, ["secrets"]);
    await writeFile(
      join(dir, "apps", "api", "pithy.config.ts"),
      `import { secrets } from "@pithy-sh/secrets/src/capability";\n${APP_CONFIG.replace(
        "export default { capabilities: [], app };",
        `const vault = secrets({
  registry: {
    SIGNING_KEY: { backend: "cf-secrets-store", scope: "environment", rotatable: true, valueType: "text", devValue: "random" },
  },
});

export default { capabilities: [vault], app };`,
      )}`,
    );
    const before = await snapshotTree(dir);

    const written = await runCaptured("provision", ["--env", "staging", "--dry-run", "--json"]);

    const plan = Plan.parse(JSON.parse(written.join("")).plan);
    expect(plan.secrets).toContainEqual({
      name: "SIGNING_KEY",
      env: "staging",
      action: "mint",
      where: "acme-staging-signing-key",
    });
    expect(account.calls).toContain("secrets.exists");
    expect(account.writes).toEqual([]);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  /**
   * **A dry run makes the refusals the run makes, before it plans (`docs/CLI.md` §1.2).** The run refuses
   * with no credentials before anything is created, so a plan here would be a promise nobody can keep: an
   * agent that read `ok` and a plan would run the real thing and meet exit 3.
   */
  test("without credentials it is refused as the run is, with nothing planned and nothing asked", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const before = await snapshotTree(dir);
    const options = { projectDir: dir, env: "staging", feature: false, yes: false, seed: false, json: true };
    const planned = await runProvision({ ...options, dryRun: true }).catch((thrown: unknown) => thrown);
    const real = await runProvision({ ...options, yes: true }).catch((thrown: unknown) => thrown);
    expect(planned).toBeInstanceOf(PithyError);
    expect((planned as PithyError).payload).toEqual((real as PithyError).payload);
    expect((planned as PithyError).payload).toMatchObject({
      code: "core/precondition_failed",
      message: "Cloudflare credentials are missing.",
    });
    expect(exitCodeOf((planned as PithyError).payload)).toBe(EXIT.precondition);
    expect(account.calls).toEqual([]);
    expect(await snapshotTree(dir)).toEqual(before);
  });
});

describe("pithy provision --feature --dry-run", () => {
  beforeEach(async () => {
    const git = (...args: string[]) => run("git", [...GIT_NO_MAINTENANCE, ...args], { cwd: dir });
    await git("init", "-q", "-b", "feature/42-maps");
    await git("-c", "user.name=Pithy", "-c", "user.email=test@pithy.sh", "commit", "-q", "--allow-empty", "-m", "init");
  });

  test("--json: the branch's plan, nothing written, only reads made", async () => {
    const before = await snapshotTree(dir);
    const written = await runCaptured("provision", ["--feature", "--dry-run", "--json"]);

    await expectConforms("provision", written);
    const payload = JSON.parse(written.join(""));
    expect(payload).toMatchObject({ command: "provision", env: "feature", dryRun: true, committed: false });
    const plan = Plan.parse(payload.plan);
    expect(plan.resources.map((resource) => [resource.kind, resource.action])).toEqual([["d1", "create"]]);
    // The feature's own record and its generated config: both are what the run writes, under ignored paths.
    expect(plan.files.map((file) => file.action)).not.toContain("delete");
    expect(plan.files.map((file) => file.path)).toContain(".pithy-feature.json");
    expect(plan.migrations.map((migration) => [migration.env, migration.name])).toEqual([
      ["feature", "1000_app_0001_things"],
    ]);
    expect(plan.notes).toContain("Then loads the seed fixtures into feature.");
    expect(await snapshotTree(dir)).toEqual(before);
    expect(account.writes).toEqual([]);
  });
  test("without credentials it is refused as the run is, naming a feature environment", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const planned = await runProvision({
      projectDir: dir,
      feature: true,
      yes: false,
      seed: false,
      json: true,
      dryRun: true,
    }).catch((thrown: unknown) => thrown);
    expect(planned).toBeInstanceOf(PithyError);
    expect((planned as PithyError).payload).toMatchObject({
      code: "core/precondition_failed",
      action:
        "Run pithy cloudflare connect, or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, to provision a feature environment.",
    });
    expect(account.calls).toEqual([]);
  });

  /**
   * **A re-run against what the run wrote plans no edit of it (#697).** The generated config carries absolute
   * paths — `absolutizePaths` points `main` back at the Worker — and in the copy that path is the copy's. A
   * file whose only difference is the copy's root is the file that is there, so it is not an edit: a plan that
   * listed it, with an empty diff, on every re-run of an already-provisioned feature was a change that is not.
   */
  test("a feature provisioned before by this run: re-planning plans no edit of its generated config", async () => {
    const path = "apps/api/.wrangler/pithy/wrangler.feature.jsonc";
    const first = Plan.parse(
      JSON.parse((await runCaptured("provision", ["--feature", "--dry-run", "--json"])).join("")).plan,
    );
    const created = first.files.find((file) => file.path === path);
    expect(created?.action).toBe("create");
    // What the real run writes: the planned creation's lines, every one an addition.
    const written = (created?.diff ?? "")
      .split("\n")
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(1));
    expect(written.join("\n")).toContain(join(dir, "apps", "api"));
    await mkdir(join(dir, "apps", "api", ".wrangler", "pithy"), { recursive: true });
    await writeFile(join(dir, path), `${written.join("\n")}\n`);

    const again = Plan.parse(
      JSON.parse((await runCaptured("provision", ["--feature", "--dry-run", "--json"])).join("")).plan,
    );
    expect(again.files.find((file) => file.path === path)).toBeUndefined();
    expect(again.files.filter((file) => file.action === "edit" && file.diff === "")).toEqual([]);
  });

  test("a feature provisioned before: its generated config is planned as an edit of the file that is there", async () => {
    // What an earlier run left: the generated config, under the ignored `.wrangler/pithy/`.
    const generated = join(dir, "apps", "api", ".wrangler", "pithy");
    await mkdir(generated, { recursive: true });
    await writeFile(join(generated, "wrangler.feature.jsonc"), '{\n  "name": "acme-api-f42-maps"\n}\n');
    const before = await snapshotTree(dir);

    const written = await runCaptured("provision", ["--feature", "--dry-run", "--json"]);

    const plan = Plan.parse(JSON.parse(written.join("")).plan);
    const config = plan.files.find((file) => file.path === "apps/api/.wrangler/pithy/wrangler.feature.jsonc");
    expect(config?.action).toBe("edit");
    expect(config?.diff).toContain('-  "name": "acme-api-f42-maps"');
    expect(await snapshotTree(dir)).toEqual(before);
    expect(account.writes).toEqual([]);
  });
});
