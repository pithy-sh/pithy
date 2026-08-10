// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyDomains } from "./applyDomains";
import { assertOriginsDeclared, checkOrigins, describeOriginDrift, originDrift } from "./domains";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-origins-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The root config. `environments` is what `checkOrigins` walks. */
async function project(environments?: string): Promise<void> {
  const declaration = environments === undefined ? "" : `, environments: ${environments}`;
  await writeFile(join(dir, "pithy.config.ts"), `export default { name: "replay"${declaration} };\n`);
}

/** One Worker under `apps/<name>`, with a `wrangler.jsonc` and an optional `domains` declaration. */
async function worker(
  name: string,
  wrangler: Record<string, unknown>,
  domains?: Record<string, { pattern: string; zone: string }>,
): Promise<string> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(
    join(workerDir, "wrangler.jsonc"),
    `${JSON.stringify({ name: `replay-${name}`, ...wrangler }, null, 2)}\n`,
  );
  await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": { "autostart": true } }\n');
  const declaration = domains === undefined ? "" : `domains: ${JSON.stringify(domains)},`;
  await writeFile(
    join(workerDir, "pithy.config.ts"),
    `const config = {\n  ${declaration}\n  capabilities: []\n};\nexport default config;\n`,
  );
  return workerDir;
}

const APP = { pattern: "app.example.com", zone: "example.com" };

describe("originDrift", () => {
  test("a declared domain with workers.dev closed names one origin and reports nothing", async () => {
    await worker(
      "board",
      { env: { prod: { workers_dev: false, vars: { BASE_URL: "https://app.example.com" } } } },
      { prod: APP },
    );
    expect(await originDrift(dir, ["prod"])).toEqual([]);
  });

  /** The first adopter's shape: a custom domain declared, and `workers.dev` never turned off. */
  test("a declared domain with no workers_dev decision is a second, unnamed origin", async () => {
    await worker("board", { env: { prod: { vars: { BASE_URL: "https://app.example.com" } } } }, { prod: APP });
    expect(await originDrift(dir, ["prod"])).toEqual([
      { worker: "board", env: "prod", fault: "workers-dev-open", origin: "https://app.example.com" },
    ]);
  });

  /** An explicit `true` is the adopter naming the second origin. Named is the whole test. */
  test("an explicit workers_dev true is a decision, not drift", async () => {
    await worker(
      "board",
      { env: { prod: { workers_dev: true, vars: { BASE_URL: "https://app.example.com" } } } },
      { prod: APP },
    );
    expect(await originDrift(dir, ["prod"])).toEqual([]);
  });

  test("a top-level workers_dev false reaches an environment stanza that states none", async () => {
    await worker(
      "board",
      { workers_dev: false, env: { prod: { vars: { BASE_URL: "https://app.example.com" } } } },
      { prod: APP },
    );
    expect(await originDrift(dir, ["prod"])).toEqual([]);
  });

  /** The state #253 was reported from: an environment the project declares and `domains` does not. */
  test("an environment with no domain, no route and no BASE_URL has no origin at all", async () => {
    await worker("board", { env: { staging: { d1_databases: [{ binding: "DB", database_id: "uuid" }] } } });
    expect(await originDrift(dir, ["staging"])).toEqual([
      { worker: "board", env: "staging", fault: "no-origin", origin: null },
    ]);
  });

  /** A custom declared environment cannot be in `domains` at all, so `vars.BASE_URL` is the way to say it. */
  test("a declared environment outside staging and prod resolves from vars.BASE_URL", async () => {
    await worker("board", { env: { live: { workers_dev: false, vars: { BASE_URL: "https://live.example.com" } } } });
    expect(await originDrift(dir, ["live"])).toEqual([]);
  });

  /** The workers.dev-only adopter: they name that origin, so the subdomain being live is not drift. */
  test("a BASE_URL naming a workers.dev host is an origin, and workers.dev may stay open", async () => {
    await worker("board", { env: { staging: { vars: { BASE_URL: "https://replay-board.acme.workers.dev" } } } });
    expect(await originDrift(dir, ["staging"])).toEqual([]);
  });

  test("a hand-written route resolves the origin, and workers.dev is still a second one", async () => {
    await worker("board", { env: { prod: { routes: [{ pattern: "api.example.com", custom_domain: true }] } } });
    expect(await originDrift(dir, ["prod"])).toEqual([
      { worker: "board", env: "prod", fault: "workers-dev-open", origin: "https://api.example.com" },
    ]);
  });

  test("a process with no wrangler.jsonc answers on nothing and is skipped", async () => {
    const workerDir = join(dir, "apps", "web");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": { "command": ["vite"] } }\n');
    expect(await originDrift(dir, ["prod"])).toEqual([]);
  });

  /**
   * A `pithy.config.ts` that will not import is exactly what might have declared the domain. Found by
   * running the real CLI on a freshly scaffolded project: before `bun install` this refused the deploy
   * and told the adopter to declare a domain that was already in the file it could not open.
   */
  test("a config nobody could import establishes nothing about what it declares", async () => {
    const workerDir = await worker("board", { env: { staging: {} } });
    await writeFile(join(workerDir, "pithy.config.ts"), 'import x from "@nope/nothing";\nexport default { app: x };\n');
    expect(await originDrift(dir, ["staging"])).toEqual([]);
  });

  /** But the workers.dev finding needs no config at all — its evidence is the wrangler file alone. */
  test("and the workers.dev finding still holds, because wrangler.jsonc is its only evidence", async () => {
    const workerDir = await worker("board", { env: { prod: { routes: ["api.example.com"] } } });
    await writeFile(join(workerDir, "pithy.config.ts"), 'import x from "@nope/nothing";\nexport default { app: x };\n');
    expect(await originDrift(dir, ["prod"])).toEqual([
      { worker: "board", env: "prod", fault: "workers-dev-open", origin: "https://api.example.com" },
    ]);
  });

  test("only the environments asked about", async () => {
    await worker("board", { env: { prod: { workers_dev: false } } }, { prod: APP });
    expect(await originDrift(dir, ["prod"])).toEqual([]);
    expect(await originDrift(dir, ["staging"])).toEqual([
      { worker: "board", env: "staging", fault: "no-origin", origin: null },
    ]);
  });
});

describe("assertOriginsDeclared", () => {
  test("refuses an environment with no origin, naming the environment and the file", async () => {
    await worker("board", { env: { staging: {} } });
    const failure = await assertOriginsDeclared(dir, "staging").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    const payload = (failure as PithyError).payload;
    expect(payload.message).toContain("staging");
    expect(payload.message).toContain("board");
    expect(`${payload.message} ${payload.action ?? ""}`).toContain("pithy.config.ts");
  });

  test("refuses a declared domain whose workers.dev origin nothing decided, naming the key", async () => {
    await worker("board", { env: { prod: {} } }, { prod: APP });
    const failure = await assertOriginsDeclared(dir, "prod").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action ?? "").toContain("workers_dev");
  });

  test("lets an environment whose origins its config names through", async () => {
    await worker("board", { env: { prod: { workers_dev: false } } }, { prod: APP });
    await expect(assertOriginsDeclared(dir, "prod")).resolves.toBeUndefined();
  });

  /**
   * A feature environment is ephemeral, has no declared domain by design, and `workers.dev` is exactly
   * how it is reached — so the gate does not apply to one.
   */
  test("a feature environment is not held to a declaration it can never have", async () => {
    await worker("board", { env: {} });
    await expect(assertOriginsDeclared(dir, "feature")).resolves.toBeUndefined();
  });
});

describe("checkOrigins", () => {
  test("walks every environment the project declares", async () => {
    await project('["staging", "prod"]');
    await worker("board", { env: { prod: { workers_dev: false } } }, { prod: APP });
    const check = await checkOrigins(dir);
    expect(check.state).toBe("drifted");
    expect(check.drift).toEqual([{ worker: "board", env: "staging", fault: "no-origin", origin: null }]);
  });

  test("a project whose config will not read establishes nothing", async () => {
    const check = await checkOrigins(dir);
    expect(check.state).toBe("could-not-check");
    expect(check.drift).toEqual([]);
  });

  test("every environment naming its origins is ok", async () => {
    await project('["prod"]');
    await worker("board", { env: { prod: { workers_dev: false } } }, { prod: APP });
    expect(await checkOrigins(dir)).toEqual({ state: "ok", drift: [] });
  });

  test("each fault carries its own sentence, and the two remedies differ", async () => {
    const open = describeOriginDrift({
      worker: "board",
      env: "prod",
      fault: "workers-dev-open",
      origin: "https://app.example.com",
    });
    const none = describeOriginDrift({ worker: "board", env: "staging", fault: "no-origin", origin: null });
    expect(open).toContain("workers_dev");
    expect(none).not.toContain("workers_dev");
    expect(none).toContain("staging");
  });
});

/**
 * **The invariant: every origin a deployed Worker answers on is one its configuration names.**
 *
 * Stated as a round trip rather than as a list of forbidden keys, because the list is what goes stale.
 * `applyDomains` is the one writer of an environment's address, so whatever it writes is the shape every
 * scaffolded project deploys — and the gate that refuses a deploy has to accept it. If either side
 * changes its mind about what a declared domain implies, this fails.
 */
describe("what pithy writes, pithy deploys", () => {
  test("a declaration applied by applyDomains satisfies the origin gate", async () => {
    const workerDir = await worker("board", { env: {} }, { prod: APP });
    await applyDomains(workerDir, { prod: APP });
    await expect(assertOriginsDeclared(dir, "prod")).resolves.toBeUndefined();
    expect(await originDrift(dir, ["prod"])).toEqual([]);
  });

  test("and the origin it wrote is the one the resolver reports", async () => {
    const workerDir = await worker("board", { env: {} }, { prod: APP });
    await applyDomains(workerDir, { prod: APP });
    const raw = JSON.parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as {
      env: { prod: { workers_dev?: boolean; vars?: { BASE_URL?: string } } };
    };
    expect(raw.env.prod.workers_dev).toBe(false);
    expect(raw.env.prod.vars?.BASE_URL).toBe("https://app.example.com");
  });
});
