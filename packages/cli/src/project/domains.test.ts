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

/** The route `applyDomains` writes, and the only shape that serves a custom domain. */
const APP_ROUTE = { pattern: "app.example.com", custom_domain: true, zone_name: "example.com" };

/**
 * **Every origin the config names has something in that config configured to serve it.**
 *
 * Stated as one question asked of the resolved address — *what serves this host?* — rather than as a list
 * of key combinations, because the list is what goes stale. #264 is what the list missed: a declared
 * domain, `workers_dev: false`, and no `routes` entry passed a gate that only ever asked what
 * `workers_dev` was set to, so the Worker answered on nothing and doctor, deploy and the post-deploy probe
 * were all green. The remedy doctor printed is what produced it.
 */
describe("originDrift", () => {
  test("a declared domain with workers.dev closed and no route is served by nothing", async () => {
    await worker(
      "board",
      { env: { prod: { workers_dev: false, vars: { BASE_URL: "https://app.example.com" } } } },
      { prod: APP },
    );
    expect(await originDrift(dir, ["prod"])).toEqual([
      {
        worker: "board",
        env: "prod",
        fault: "unserved-origin",
        origin: "https://app.example.com",
        source: "declaration",
      },
    ]);
  });

  test("and the route is the whole difference — with it, the same config is clean", async () => {
    await worker(
      "board",
      { env: { prod: { workers_dev: false, routes: [APP_ROUTE], vars: { BASE_URL: "https://app.example.com" } } } },
      { prod: APP },
    );
    expect(await originDrift(dir, ["prod"])).toEqual([]);
  });

  /** The declaration is authoritative, so a route for some other host serves nothing it named. */
  test("a route for a different host does not serve the declared one", async () => {
    await worker(
      "board",
      { env: { prod: { workers_dev: false, routes: [{ pattern: "api.example.com", custom_domain: true }] } } },
      { prod: APP },
    );
    expect(await originDrift(dir, ["prod"])).toEqual([
      {
        worker: "board",
        env: "prod",
        fault: "unserved-origin",
        origin: "https://app.example.com",
        source: "declaration",
      },
    ]);
  });

  /** A pattern is a matcher, not a literal — a wildcard route over the zone serves the declared host. */
  test("a wildcard route covering the host serves it", async () => {
    await worker("board", { env: { prod: { workers_dev: false, routes: ["*.example.com/*"] } } }, { prod: APP });
    expect(await originDrift(dir, ["prod"])).toEqual([]);
  });

  /**
   * The same invariant, from the other end. An adopter whose named origin *is* the subdomain has closed
   * the only thing that serves it — one fact, one rule, and no separate check for the mirror image.
   */
  test("a named workers.dev origin with workers_dev false is served by nothing either", async () => {
    await worker("board", {
      env: { staging: { workers_dev: false, vars: { BASE_URL: "https://replay-board.acme.workers.dev" } } },
    });
    expect(await originDrift(dir, ["staging"])).toEqual([
      {
        worker: "board",
        env: "staging",
        fault: "unserved-origin",
        origin: "https://replay-board.acme.workers.dev",
        source: "var",
      },
    ]);
  });

  /** The first adopter's shape: a custom domain declared and routed, and `workers.dev` never turned off. */
  test("a declared domain with no workers_dev decision is a second, unnamed origin", async () => {
    await worker(
      "board",
      { env: { prod: { routes: [APP_ROUTE], vars: { BASE_URL: "https://app.example.com" } } } },
      { prod: APP },
    );
    expect(await originDrift(dir, ["prod"])).toEqual([
      { worker: "board", env: "prod", fault: "workers-dev-open", origin: "https://app.example.com" },
    ]);
  });

  /** An explicit `true` is the adopter naming the second origin. Named is the whole test. */
  test("an explicit workers_dev true is a decision, not drift", async () => {
    await worker(
      "board",
      { env: { prod: { workers_dev: true, routes: [APP_ROUTE], vars: { BASE_URL: "https://app.example.com" } } } },
      { prod: APP },
    );
    expect(await originDrift(dir, ["prod"])).toEqual([]);
  });

  test("a top-level workers_dev false reaches an environment stanza that states none", async () => {
    await worker(
      "board",
      { workers_dev: false, env: { prod: { routes: [APP_ROUTE], vars: { BASE_URL: "https://app.example.com" } } } },
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
    await worker("board", {
      env: {
        live: {
          workers_dev: false,
          routes: [{ pattern: "live.example.com", custom_domain: true }],
          vars: { BASE_URL: "https://live.example.com" },
        },
      },
    });
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
    await worker("board", { env: { prod: { workers_dev: false, routes: [APP_ROUTE] } } }, { prod: APP });
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
    await worker("board", { env: { prod: { routes: [APP_ROUTE] } } }, { prod: APP });
    const failure = await assertOriginsDeclared(dir, "prod").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action ?? "").toContain("workers_dev");
  });

  /**
   * #264: the state doctor's own `workers_dev` remedy produces. Deploy is the last moment before a Worker
   * that answers at no address is shipped as a success, so it refuses — naming the route, not workers.dev.
   */
  test("refuses a declared domain nothing routes to, naming the route and the command", async () => {
    await worker("board", { env: { prod: { workers_dev: false } } }, { prod: APP });
    const failure = await assertOriginsDeclared(dir, "prod").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    const action = (failure as PithyError).payload.action ?? "";
    expect(action).toContain("route");
    expect(action).toContain("pithy worker sync");
    expect(action).not.toContain("workers_dev");
  });

  test("lets an environment whose origins its config names and serves through", async () => {
    await worker("board", { env: { prod: { workers_dev: false, routes: [APP_ROUTE] } } }, { prod: APP });
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
    await worker("board", { env: { prod: { workers_dev: false, routes: [APP_ROUTE] } } }, { prod: APP });
    const check = await checkOrigins(dir);
    expect(check.state).toBe("drifted");
    expect(check.drift).toEqual([{ worker: "board", env: "staging", fault: "no-origin", origin: null }]);
  });

  test("a project whose config will not read establishes nothing", async () => {
    const check = await checkOrigins(dir);
    expect(check.state).toBe("could-not-check");
    expect(check.drift).toEqual([]);
  });

  test("every environment naming and serving its origins is ok", async () => {
    await project('["prod"]');
    await worker("board", { env: { prod: { workers_dev: false, routes: [APP_ROUTE] } } }, { prod: APP });
    expect(await checkOrigins(dir)).toEqual({ state: "ok", drift: [] });
  });

  test("each fault carries its own sentence, and the three remedies differ", async () => {
    const open = describeOriginDrift({
      worker: "board",
      env: "prod",
      fault: "workers-dev-open",
      origin: "https://app.example.com",
    });
    const none = describeOriginDrift({ worker: "board", env: "staging", fault: "no-origin", origin: null });
    const unserved = describeOriginDrift({
      worker: "board",
      env: "prod",
      fault: "unserved-origin",
      origin: "https://app.example.com",
      source: "declaration",
    });
    expect(open).toContain("workers_dev");
    expect(none).not.toContain("workers_dev");
    expect(none).toContain("staging");
    // The whole point of #264: the sentence names the missing route, and never sends anyone back to the
    // key whose remedy produced the state.
    expect(unserved).toContain("route");
    expect(unserved).toContain("pithy worker sync");
    expect(unserved).not.toContain("workers_dev");
  });

  /** A hand-set `vars.BASE_URL` is not generated from anything, so `worker sync` cannot write its route. */
  test("an unserved origin nobody declared is told to write the route, not to run a command", () => {
    const unserved = describeOriginDrift({
      worker: "board",
      env: "live",
      fault: "unserved-origin",
      origin: "https://live.example.com",
      source: "var",
    });
    expect(unserved).toContain("live.example.com");
    expect(unserved).toContain("routes");
    expect(unserved).not.toContain("pithy worker sync");
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

  test("and the origin it wrote is the one the resolver reports, with something serving it", async () => {
    const workerDir = await worker("board", { env: {} }, { prod: APP });
    await applyDomains(workerDir, { prod: APP });
    const raw = JSON.parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as {
      env: { prod: { workers_dev?: boolean; routes?: unknown[]; vars?: { BASE_URL?: string } } };
    };
    expect(raw.env.prod.workers_dev).toBe(false);
    expect(raw.env.prod.vars?.BASE_URL).toBe("https://app.example.com");
    // The half #264 was about. `workers_dev: false` with no route is a Worker reachable at no address,
    // and the two are written by the same call precisely so neither can arrive without the other.
    expect(raw.env.prod.routes).toEqual([APP_ROUTE]);
  });
});
