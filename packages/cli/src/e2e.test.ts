// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "comment-json";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, expect, test } from "vitest";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");
const REPO = resolve(import.meta.dirname, "..", "..", "..");

/**
 * The Phase 0 definition of done, executed end to end: an empty directory becomes
 * a Worker that boots, validates per-env config, serves `GET /health`, and runs
 * its (empty) migration registry clean.
 *
 * The scaffold lands inside the package — not the OS tmpdir — so its
 * `@pithy-sh/core` and `hono` imports resolve against the workspace node_modules
 * (the "linked workspace packages" leg). A literal `bun install` would instead
 * reach for the unpublished `@pithy-sh/core@^0.0.0` on npm; the in-package
 * scaffold is the faithful local stand-in, matching `bin.test.ts`.
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", ".e2e-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("empty dir → init → boots, serves /health 200, migrates the empty registry clean", async () => {
  const target = join(dir, "app");

  // 1. Scaffold non-interactively — the way an agent drives it (spec §10.20).
  await run("bun", [bin, "init", "--name", "smoke-app", "--dir", target, "--json"]);

  // 2. The scaffold's worker lives in apps/api and carries dev, staging, and production config paths.
  const workerDir = join(target, "apps", "api");
  const wrangler = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
    compatibility_date: string;
    compatibility_flags: string[];
    env: { staging: unknown; prod: unknown };
  };
  expect(wrangler.env.staging).toBeDefined();
  expect(wrangler.env.prod).toBeDefined();

  // 3. Bundle the Worker entry — resolving `@pithy-sh/core` and `hono` — and boot
  //    it under Miniflare, the same workerd runtime `wrangler dev` runs locally,
  //    using the scaffold's own compatibility settings.
  const bundle = join(target, ".worker.mjs");
  await run("bun", ["build", join(workerDir, "src", "index.ts"), "--outfile", bundle, "--target=node"]);
  const miniflare = new Miniflare({
    modules: true,
    script: await readFile(bundle, "utf8"),
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags,
  });
  try {
    const res = await miniflare.dispatchFetch("http://localhost/health");
    expect(res.status).toBe(200);
    // `version` is null here because this harness builds its own Miniflare from the scaffolded
    // `wrangler.jsonc` without a version-metadata binding — Cloudflare populates that at deploy, and
    // there is no deploy in an e2e that never leaves the machine. The scaffold *declares* it, which is
    // what `scaffoldParity.test.ts` pins.
    expect(await res.json()).toEqual({ status: "ok", version: null });
  } finally {
    await miniflare.dispose();
  }

  // 4. The empty migration registry runs clean — no databases, no error — reported per worker.
  const { stdout } = await run("bun", [bin, "migrate", "--json"], { cwd: target });
  expect(JSON.parse(stdout.trim())).toEqual({
    command: "migrate",
    env: "dev",
    project: "smoke-app",
    rollback: false,
    workers: [{ worker: "smoke-app-api", databases: [] }],
  });
});

/**
 * **The five minutes, run with the real binary: `init`, `add auth`, and a project that boots.**
 *
 * This is the acceptance criterion #273 was filed on, and the reason it is here rather than in a unit
 * suite is that every part of the defect lived between commands. `pithy add auth` installed the package,
 * wrote the registration, and reported `Done.` on a Worker that could not start, because `auth`'s
 * manifest declares `secrets` and `email` and nothing read that declaration. `pithy doctor` called the
 * project healthy. Both commands were individually well tested.
 *
 * So the commands are spawned, not called: `bun bin.ts <argv>`, exactly as an adopter or an agent runs
 * them, with `--json` so what is asserted is the contract and not the prose.
 *
 * The boot itself is `project/scaffoldBoot.test.ts` — a Worker composing `better-auth` pulls an optional
 * `@opentelemetry/api` import that no bundler here resolves, so the composition is proved node-side
 * there. What only this file can prove is the command surface: the refusal, the flag, the order, and
 * that the migrations of a capability composed as a prerequisite are actually applied.
 */

/** Every kit package the composed Worker imports, linked the way a working checkout is. */
const LINKED = ["core", "auth", "email", "secrets", "turnstile", "audit", "cloudflare"];

/**
 * Scaffold a project and link the kit into it.
 *
 * Nothing under `@pithy-sh/*` is published, so a real `bun add` would 404. A link that resolves outside
 * `node_modules` is the "checkout" leg `installPackage` already recognizes and skips — the same shape a
 * contributor working against this repository has, and the only one that lets `pithy add` run for real.
 */
async function scaffoldLinked(target: string): Promise<string> {
  await run("bun", [bin, "init", "--name", "replay", "--worker", "board", "--dir", target, "--json"]);
  const scope = join(target, "node_modules", "@pithy-sh");
  await rm(scope, { recursive: true, force: true });
  await mkdir(scope, { recursive: true });
  for (const pkg of LINKED) await symlink(join(REPO, "packages", pkg), join(scope, pkg));
  return join(target, "apps", "board");
}

/** Run the CLI and give back the exit code with both streams, whichever way it ended. */
async function cli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("pithy add auth on a bare project refuses non-interactively, naming the exact commands", async () => {
  const target = join(dir, "app");
  await scaffoldLinked(target);

  const refused = await cli(["add", "auth", "--worker", "board", "--json"], target);

  // Non-zero, because a run that cannot be asked a question must not answer it by guessing — and the
  // guess that composes two capabilities nobody named is the worse of the two.
  expect(refused.code).not.toBe(0);
  expect(JSON.parse(refused.stderr.trim())).toEqual({
    error: {
      code: "validation/invalid_input",
      status: 400,
      issues: [],
      message: "auth requires secrets and email, which board does not compose.",
      action:
        "Run pithy add auth --with-prerequisites, or compose them first: pithy add secrets, then pithy add email.",
    },
  });

  // And it wrote nothing. A refusal that had already half-wired the config would leave the adopter worse
  // off than the defect did.
  const config = await readFile(join(target, "apps", "board", "pithy.config.ts"), "utf8");
  expect(config).not.toMatch(/^\s*auth\(/m);
}, 180_000);

test("pithy add auth --with-prerequisites composes secrets, email and auth, and migrates all three", async () => {
  const target = join(dir, "app");
  const workerDir = await scaffoldLinked(target);

  const added = await cli(["add", "auth", "--worker", "board", "--with-prerequisites", "--json"], target);
  expect(added.code).toBe(0);
  const result = JSON.parse(added.stdout.trim()) as {
    capability: string;
    prerequisites: string[];
    databases: { database: string; results: { migrationName: string; status: string }[] }[];
  };

  expect(result.capability).toBe("auth");
  expect(result.prerequisites).toEqual(["secrets", "email"]);

  // All three registered in the one Worker's config — composed, not merely installed.
  const config = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
  for (const capability of ["secrets", "email", "auth"]) {
    expect(config).toMatch(new RegExp(`^\\s*${capability}\\(`, "m"));
  }

  // The bindings each of them needs, in the environment `pithy dev` reads. Without these the Worker
  // assembles and then fails validation on the first request — #258, the other half of this path.
  const stanza = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
    d1_databases?: { binding: string }[];
    ratelimits?: { name: string }[];
    workflows?: { binding: string }[];
  };
  const bound = [
    ...(stanza.d1_databases ?? []).map((entry) => entry.binding),
    ...(stanza.ratelimits ?? []).map((entry) => entry.name),
    ...(stanza.workflows ?? []).map((entry) => entry.binding),
  ].sort();
  expect(bound).toEqual(["AUTH_RATE_LIMITER", "DB", "EMAIL_SENDER", "EMAIL_SUPPRESSIONS", "SECRETS"]);

  // **And the migrations ran.** `add` re-reads the config it just wrote to build the registry, and the
  // module cache used to hand it back the module from *before* the write — so a `pithy add` applied none
  // of the migrations it reported, and `pithy dev` then served 500s off tables nothing had created. This
  // run reports only `auth`'s, which is correct: each prerequisite applied its own inside its own add,
  // and there is nothing left for this one to do about them. Before the fix the list was empty.
  const applied = result.databases.flatMap((database) => database.results.map((entry) => entry.migrationName));
  expect(applied).toEqual(["0300_auth_0001_init"]);
  expect(result.databases.every((database) => database.results.every((entry) => entry.status === "Success"))).toBe(
    true,
  );

  // The whole registry, from the command that counts what is left. Nothing pending is the only statement
  // that covers the prerequisites' migrations too, and it is the one an adopter would have hit first:
  // `pithy dev` on an unmigrated schema is a 500 on every route that touches a table.
  const checked = await cli(["doctor", "--json"], target);
  const health = JSON.parse(checked.stdout.trim()) as {
    project: {
      health: { workers: { migrations: { ok: boolean; ledger: { state: string; pending: number } } }[] };
    };
  };
  // `ledger.state` is asserted beside the count, because since #371 a count on its own no longer says the
  // comparison happened: a database that could not be read reports no `pending` at all, and matching on
  // `ok` alone would pass on a `partial` read of a schema nobody compared.
  expect(health.project.health.workers[0]?.migrations).toMatchObject({
    ok: true,
    ledger: { state: "read", pending: 0 },
  });
}, 300_000);

test("pithy doctor reports a composed capability whose prerequisite is absent, and fails the exit", async () => {
  const target = join(dir, "app");
  const workerDir = await scaffoldLinked(target);

  // `audit` composes cleanly on its own — it declares no peers — so the project is healthy but for the
  // pending migration it just wrote. That is the baseline the prerequisite line is read against.
  expect((await cli(["add", "audit", "--worker", "board", "--json"], target)).code).toBe(0);
  const healthy = await cli(["doctor", "--json"], target);
  const before = JSON.parse(healthy.stdout.trim()) as {
    project: { health: { workers: { prerequisites: { ok: boolean; missing: unknown[] } }[] } };
  };
  expect(before.project.health.workers[0]?.prerequisites).toEqual({ ok: true, missing: [] });

  // Now the state this fix means no command can produce any more, and which every project composing
  // `auth` was in before it: the capability registered with neither peer beside it. `createBackend`
  // refuses to assemble that, so it is a Worker that does not start — and `doctor` called it healthy.
  //
  // Built by composing the real thing and then dropping the two prerequisite registrations, rather than
  // by hand-writing `auth()`: the options a capability needs to construct are its own business, and a
  // config that throws on load is a different failure that would pass this test for the wrong reason.
  expect((await cli(["add", "auth", "--worker", "board", "--with-prerequisites", "--json"], target)).code).toBe(0);
  const path = join(workerDir, "pithy.config.ts");
  let source = await readFile(path, "utf8");
  for (const capability of ["secrets", "email"]) {
    source = source.replace(new RegExp(`^ {4}${capability}\\(\\{\\n[\\s\\S]*?^ {4}\\}\\),\\n`, "m"), "");
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, source);
  expect(source).toMatch(/^\s*auth\(/m);
  for (const capability of ["secrets", "email"]) {
    expect(source).not.toMatch(new RegExp(`^\\s*${capability}\\(`, "m"));
  }

  const sick = await cli(["doctor", "--json"], target);
  const after = JSON.parse(sick.stdout.trim()) as {
    project: {
      loadError?: string;
      health: { ok: boolean; workers: { prerequisites: { ok: boolean; missing: unknown[] } }[] };
    };
  };
  // The config still loads. What it cannot do is assemble, which is the distinction being tested.
  expect(after.project.loadError).toBeUndefined();
  expect(after.project.health.workers[0]?.prerequisites).toEqual({
    ok: false,
    missing: [
      { capability: "auth", requires: "secrets" },
      { capability: "auth", requires: "email" },
    ],
  });
  expect(after.project.health.ok).toBe(false);
  // The exit is the gate CI reads. A report nobody fails on is a report nobody notices.
  expect(sick.code).not.toBe(0);
}, 300_000);
