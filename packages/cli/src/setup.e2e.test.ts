// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { localResourceRoot } from "./devSecrets/store";
import { DEFAULT_WORKER, scaffoldProject } from "./project/scaffold";
import { resolveStoreIds } from "./seed/drivers";
import { linkKitPackages } from "./test-utils/linkKit";
import { removeTempDir } from "./test-utils/tempRepo";

/**
 * **`pithy setup` on a fresh clone, run end to end through the real binary (#764).**
 *
 * One project is created the way its first developer creates it — scaffolded, `pithy add auth` composing
 * `secrets` and `email` with it, committed. Every case then clones it, the way the second developer gets it, and
 * gives the clone a Pithy config directory of its own: a machine that has never seen this project. The kit is
 * linked into each clone's `node_modules` and setup runs with `--skip-install`, because nothing under `@pithy-sh/*`
 * is on a registry a test can install from — the install step is `setup/install.test.ts`'s.
 *
 * **No credentials anywhere, and `PITHY_OFFLINE=1`.** No `CLOUDFLARE_*` in the environment, no `cloudflare.json`
 * and no session in the config directory. A run that reached for an account would refuse or fail; this one is
 * held to succeeding.
 */

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");
const PROJECT = "replay";
const WORKER = DEFAULT_WORKER;
const KIT = ["core", "auth", "email", "secrets", "turnstile", "audit", "cloudflare"];

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** The environment of a machine with no Cloudflare credentials at all, configured from `configDir`. */
function offline(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PITHY_CONFIG_DIR: configDir, PITHY_OFFLINE: "1", NO_COLOR: "1" };
  for (const key of Object.keys(env)) if (key.startsWith("CLOUDFLARE_")) delete env[key];
  return env;
}

/** One run of the real binary, as an outcome rather than an exception. */
async function pithy(args: string[], cwd: string, configDir: string): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], { cwd, env: offline(configDir), timeout: 170_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  return stdout;
}

/** The one JSON line a `--json` run wrote. */
function payload(outcome: Outcome): Record<string, unknown> {
  expect(outcome.code, outcome.stderr).toBe(0);
  return JSON.parse(outcome.stdout) as Record<string, unknown>;
}

const dirs: string[] = [];
let origin: string;

/** A fresh clone of the project and a config directory nothing has written to yet. */
async function clone(): Promise<{ dir: string; config: string }> {
  const root = await mkdtemp(join(tmpdir(), "pithy-setup-e2e-"));
  dirs.push(root);
  const dir = join(root, "clone");
  await git(["clone", "--quiet", origin, dir], root);
  await linkKitPackages(dir, KIT);
  return { dir, config: join(root, "config") };
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "pithy-setup-origin-"));
  dirs.push(root);
  origin = join(root, "origin");
  await scaffoldProject({ targetDir: origin, appName: PROJECT, worker: WORKER });
  await linkKitPackages(origin, KIT);
  const added = await pithy(["add", "auth", "--worker", WORKER, "--with-prerequisites"], origin, join(root, "config"));
  expect(added.code, added.stderr).toBe(0);
  await git(["init", "--quiet", "-b", "main"], origin);
  await git(["add", "-A"], origin);
  await git(["commit", "--quiet", "-m", "init"], origin);
}, 240_000);

afterAll(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

describe("pithy setup on a fresh clone", () => {
  test("installs nothing it was told not to, mints, migrates, pins ports, generates .dev.vars, and leaves git clean", async () => {
    const { dir, config } = await clone();

    const result = payload(await pithy(["setup", "--skip-install", "--json"], dir, config));

    expect(result.outcome).toBe("ready");
    expect(result.project).toBe(PROJECT);
    expect(result.install).toBeNull();
    const secrets = result.localSecrets as { path: string; minted: string[] };
    expect(secrets.path).toBe(join(config, PROJECT, "secrets.jsonc"));
    expect(secrets.minted).toEqual(["SECRETS_ENCRYPTION_KEYS", "auth-session-secret", "email-link-signing-key"]);
    expect((result.appliedMigrations as string[]).length).toBeGreaterThan(0);
    const ports = result.ports as { allocated: boolean; workers: Record<string, { port: number }> };
    expect(ports.allocated).toBe(true);
    expect(Object.keys(ports.workers)).toContain(`${PROJECT}-${WORKER}`);
    expect(result.devVarsWritten).toEqual([`apps/${WORKER}`]);
    expect(existsSync(join(dir, "apps", WORKER, ".dev.vars"))).toBe(true);
    expect(existsSync(join(dir, ".dev.config.json"))).toBe(true);
    expect(result.next).toEqual([
      { command: "pithy dev", why: "Setup starts nothing. The Workers run under pithy dev." },
    ]);

    // Nothing tracked was touched, `pithy.config.ts` included.
    expect(await git(["status", "--porcelain"], dir)).toBe("");

    // And `pithy dev` needs nothing more: doctor finds no local gap, and the dev set has every port it binds.
    const doctor = JSON.parse((await pithy(["doctor", "--json"], dir, config)).stdout) as { failures: unknown[] };
    expect(doctor.failures).toEqual([]);
    const listing = payload(await pithy(["dev", "--list", "--json"], dir, config)) as {
      members: { name: string; port: number | null }[];
    };
    expect(listing.members.every((member) => member.port !== null)).toBe(true);
  }, 300_000);

  test("a second run changes nothing and says so", async () => {
    const { dir, config } = await clone();
    payload(await pithy(["setup", "--skip-install", "--json"], dir, config));
    const secrets = await readFile(join(config, PROJECT, "secrets.jsonc"), "utf8");
    const ports = await readFile(join(dir, ".dev.config.json"), "utf8");

    const again = await pithy(["setup", "--skip-install"], dir, config);

    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("Already set up. Nothing changed.");
    expect(again.stdout).toContain("Next: pithy dev.");
    expect(await readFile(join(config, PROJECT, "secrets.jsonc"), "utf8")).toBe(secrets);
    expect(await readFile(join(dir, ".dev.config.json"), "utf8")).toBe(ports);
    expect(payload(await pithy(["setup", "--skip-install", "--json"], dir, config)).outcome).toBe("unchanged");
  }, 300_000);

  test("a second clone on the same machine reuses the first clone's secrets and mints nothing", async () => {
    const first = await clone();
    payload(await pithy(["setup", "--skip-install", "--json"], first.dir, first.config));
    const secrets = await readFile(join(first.config, PROJECT, "secrets.jsonc"), "utf8");
    const second = await clone();

    const result = payload(await pithy(["setup", "--skip-install", "--json"], second.dir, first.config));

    expect((result.localSecrets as { minted: string[] }).minted).toEqual([]);
    expect(await readFile(join(first.config, PROJECT, "secrets.jsonc"), "utf8")).toBe(secrets);
    // Its own ports, not the first clone's: one block per checkout.
    const one = JSON.parse(await readFile(join(first.dir, ".dev.config.json"), "utf8")) as { ports: { base: number } };
    const two = JSON.parse(await readFile(join(second.dir, ".dev.config.json"), "utf8")) as { ports: { base: number } };
    expect(two.ports.base).not.toBe(one.ports.base);
  }, 300_000);

  test("a dev database holding rows is not seeded, and the run names the table", async () => {
    const { dir, config } = await clone();
    payload(await pithy(["setup", "--skip-install", "--json"], dir, config));
    await insertUser(dir);

    const result = payload(await pithy(["setup", "--skip-install", "--json"], dir, config));

    expect(result.seed).toEqual({
      state: "held",
      held: [{ worker: `${PROJECT}-${WORKER}`, binding: "DB", table: "pithy_auth_users" }],
    });
    expect(result.notes).toEqual([]);
  }, 300_000);

  test("--dry-run prints every step and writes nothing, in the checkout or on the machine", async () => {
    const { dir, config } = await clone();
    const before = await readdir(dir);

    const outcome = await pithy(["setup", "--skip-install", "--dry-run"], dir, config);

    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain("Would mint SECRETS_ENCRYPTION_KEYS (dev)");
    expect(outcome.stdout).toContain("Would apply 0100_secrets_0001_init to secrets (SECRETS, dev).");
    expect(outcome.stdout).toContain("Would create .dev.config.json.");
    expect(outcome.stdout).toContain(`Would edit apps/${WORKER}/.dev.vars.`);
    expect(outcome.stdout).toContain("Dry run. Nothing written.");
    expect(await readdir(dir)).toEqual(before);
    expect(existsSync(join(dir, "apps", WORKER, ".dev.vars"))).toBe(false);
    expect(existsSync(join(config, PROJECT))).toBe(false);
    expect(existsSync(join(config, "dev-ports.json"))).toBe(false);
  }, 300_000);

  test("a project check that fails stops the run before any step writes, naming the failure", async () => {
    const { dir, config } = await clone();
    await rm(join(dir, "apps", WORKER, "pithy.config.ts"));

    const outcome = await pithy(["setup", "--skip-install"], dir, config);

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain("Every worker here is missing its pithy.config.ts.");
    expect(outcome.stderr).toContain(`Missing: ${PROJECT}-${WORKER}.`);
    expect(existsSync(join(config, PROJECT))).toBe(false);
    expect(existsSync(join(dir, ".dev.config.json"))).toBe(false);
    expect(existsSync(join(dir, ".wrangler"))).toBe(false);
  }, 300_000);

  test("pithy doctor on a never-set-up clone names pithy setup", async () => {
    const { dir, config } = await clone();

    const outcome = await pithy(["doctor"], dir, config);

    expect(outcome.stdout).toContain("dev: 9 pending — run: pithy setup");
    expect(outcome.stdout).toContain("Run `pithy setup` — it mints one into");
    expect(outcome.stdout).not.toContain("pithy add secrets");
  }, 300_000);
});

/** Write one row into the clone's local users table, through the store `pithy dev` reads. */
async function insertUser(dir: string): Promise<void> {
  const ids = await resolveStoreIds({ workerDir: join(dir, "apps", WORKER), env: "dev" });
  const id = ids.d1.get("DB");
  if (id === undefined) throw new Error("the scaffolded Worker binds no DB");
  const { convertV4MiniflareOptions, Miniflare } = await import("miniflare");
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      d1Databases: { DB: id },
      resourcePersistencePath: localResourceRoot(dir),
    }),
  );
  try {
    const db = (await miniflare.getD1Database("DB")) as unknown as D1Database;
    await db
      .prepare(
        "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values ('u1', 'Ada', 'ada@example.com', 1, 0, 0)",
      )
      .run();
  } finally {
    await miniflare.dispose();
  }
}
