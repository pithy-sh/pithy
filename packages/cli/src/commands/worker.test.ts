// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDef } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { originDrift } from "../project/domains";
import worker from "./worker";

/**
 * **`pithy worker sync` is the non-interactive writer of a Worker's address (#264).**
 *
 * `applyDomains` writes the `custom_domain` route a `domains` block implies, and until this command its
 * only caller was an interactive prompt — so a declaration added by hand had no route behind it, and every
 * check downstream read the declaration rather than the route and called it healthy. The pair of
 * assertions that matter are here: the command writes the route from an existing declaration, and running
 * it twice does nothing at all.
 */

const sync = (worker.subCommands as Record<string, CommandDef>).sync as CommandDef;

let dir: string;
let cwd: string;

/** A one-Worker project: a root config, and `apps/board` with a `domains` block and no route. */
async function project(domains: string): Promise<string> {
  const workerDir = join(dir, "apps", "board");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
  await writeFile(
    join(workerDir, "wrangler.jsonc"),
    `${JSON.stringify({ name: "replay-board", env: { prod: { vars: { ENVIRONMENT: "prod" } } } }, null, 2)}\n`,
  );
  await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": { "autostart": true } }\n');
  await writeFile(
    join(workerDir, "pithy.config.ts"),
    `const config = {\n  domains: ${domains},\n  capabilities: []\n};\nexport default config;\n`,
  );
  return workerDir;
}

/** Run the subcommand from inside the project, capturing what it printed. */
async function run(args: Record<string, unknown>): Promise<string> {
  const written: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await sync.run?.({ args: { json: false, ...args }, rawArgs: [] } as never);
  } finally {
    stdout.mockRestore();
  }
  return written.join("");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-sync-"));
  cwd = process.cwd();
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

describe("worker sync", () => {
  test("writes the route a hand-edited domains block implies, and the origin gate then passes", async () => {
    const workerDir = await project('{ prod: { pattern: "app.example.com", zone: "example.com" } }');
    // The state #264 is about: declared, unrouted, and reported as a fault until something writes it.
    expect(await originDrift(dir, ["prod"])).toEqual([
      {
        worker: "board",
        env: "prod",
        fault: "unserved-origin",
        origin: "https://app.example.com",
        source: "declaration",
      },
    ]);

    const output = await run({});

    expect(output).toContain("prod: routed to app.example.com.");
    const config = JSON.parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as {
      env: { prod: { routes?: unknown[]; workers_dev?: boolean; vars?: { BASE_URL?: string } } };
    };
    expect(config.env.prod.routes).toEqual([
      { pattern: "app.example.com", custom_domain: true, zone_name: "example.com" },
    ]);
    expect(config.env.prod.workers_dev).toBe(false);
    expect(config.env.prod.vars?.BASE_URL).toBe("https://app.example.com");
    // The round trip that closes the loop: what this command writes, `pithy doctor` and `pithy deploy`
    // accept. A gate the fixer cannot satisfy is worse than no gate.
    expect(await originDrift(dir, ["prod"])).toEqual([]);
  });

  test("a second run changes nothing and says so", async () => {
    const workerDir = await project('{ prod: { pattern: "app.example.com", zone: "example.com" } }');
    await run({});
    const first = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");

    const output = await run({});

    expect(output).toContain("already in sync");
    expect(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")).toBe(first);
  });

  test("--env writes that environment's route and leaves the other declaration alone", async () => {
    const workerDir = await project(
      '{ staging: { pattern: "staging.example.com", zone: "example.com" }, prod: { pattern: "app.example.com", zone: "example.com" } }',
    );

    await run({ env: "prod" });

    const config = JSON.parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as {
      env: Record<string, { routes?: unknown[] } | undefined>;
    };
    expect(config.env.prod?.routes).toHaveLength(1);
    expect(config.env.staging).toBeUndefined();
  });

  test("reports the route in --json, so an agent can read what it wrote", async () => {
    await project('{ prod: { pattern: "app.example.com", zone: "example.com" } }');

    const output = await run({ json: true });

    expect(JSON.parse(output)).toMatchObject({
      command: "worker.sync",
      worker: "board",
      deployedAs: "replay-board",
      routes: [{ env: "prod", pattern: "app.example.com", baseUrl: "https://app.example.com", changed: true }],
      runs: [],
    });
  });

  test("a Worker that declares neither domains nor an app is told so, rather than told about workflows", async () => {
    await project("undefined");
    const said: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    try {
      await sync.run?.({ args: { json: false }, rawArgs: [] } as never).catch(() => undefined);
    } finally {
      stderr.mockRestore();
    }
    expect(said.join("")).toContain("declares neither domains nor an app capability");
  });
});
