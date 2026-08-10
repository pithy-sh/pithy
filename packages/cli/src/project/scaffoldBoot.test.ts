// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import { parse } from "comment-json";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runAdd } from "../capabilities/flow";
import { writeDevVars } from "../devSecrets/devVars";
import { loadWorkerConfig } from "./config";
import { scaffoldProject } from "./scaffold";

/**
 * The shortest path through the product, run end to end: **scaffold, compose, boot, `GET /health`.**
 *
 * `pithy init` → `pithy add secrets` → `pithy add email` → `pithy add auth` → `pithy dev` →
 * `curl /health` answered **500** on every route, because `@pithy-sh/auth` requires
 * `ratelimit:AUTH_RATE_LIMITER` and `@pithy-sh/email` requires `workflow:EMAIL_SENDER` and nothing wrote
 * either binding into the Worker's `wrangler.jsonc` (#258). Two agents hit it independently, days apart,
 * in different scratch projects.
 *
 * **It was invisible to every unit test in the repo**, and the reason is worth stating: it lives in the
 * gap between two commands. `add`'s tests assert what `add` writes. `createBackend`'s tests assert what
 * the composition refuses to boot without. Neither one asks whether the first satisfies the second, and
 * that question is the whole defect.
 *
 * So this asks it, and asks it the only honest way — **the Worker's env is built from the files the
 * commands wrote**, never from a literal. Every binding comes out of the scaffolded `wrangler.jsonc`
 * stanza, and every secret out of the `.dev.vars` the dev-secrets generator produces, which is exactly
 * what `wrangler dev` reads. A binding no command wrote is a binding this env does not have, and the
 * request fails the way an adopter's did.
 *
 * Node-side rather than under Miniflare, deliberately: `/health` touches no binding's *behaviour*, only
 * its presence, and bundling a Worker that composes `better-auth` pulls an optional `@opentelemetry/api`
 * import that no bundler in this repo resolves. `project/scaffoldGates.test.ts` covers the compile and
 * `e2e.test.ts` the workerd boot; what is missing, and only missing, is the composition.
 */

/** The two names, deliberately unequal — the fixture in `scaffoldGates.test.ts` explains why. */
const PROJECT = "replay";
const WORKER = "board";

/** Every kit package the composed Worker imports, linked in the way a checkout is. */
const LINKED = ["core", "auth", "email", "secrets", "turnstile", "audit", "cloudflare"];

const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");

let dir: string;
let workerDir: string;

/**
 * Scaffolded **inside `packages/cli`**, not the OS tmpdir, for the same reason `e2e.test.ts` is: vitest
 * only transforms a TypeScript config that lives under the project root, and this test loads the
 * scaffolded `pithy.config.ts` for real. It is also what makes `@pithy-sh/*` resolve — through the
 * workspace's own `node_modules`, the "linked checkout" leg the CLI already supports.
 */
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".boot-"));
  await scaffoldProject({ targetDir: dir, appName: PROJECT, worker: WORKER });
  workerDir = join(dir, "apps", WORKER);

  // A linked checkout: the manifest loader reads `<project>/node_modules/@pithy-sh/<pkg>`, and
  // `alreadyProvided` recognizes a link that resolves outside `node_modules` and skips the install —
  // so no registry is reached for packages that are not published.
  const scope = join(dir, "node_modules", "@pithy-sh");
  await rm(scope, { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(scope, { recursive: true });
  for (const pkg of LINKED) await symlink(join(REPO, "packages", pkg), join(scope, pkg));

  // The order the docs teach, and the order the issue reproduces in. The dev master key `add secrets`
  // mints, and the signing keys `email` and `auth` mint, land in this project's dev secrets file.
  for (const capability of ["secrets", "email", "auth"]) {
    await runAdd({
      account: null,
      projectDir: dir,
      workerDir,
      worker: WORKER,
      project: PROJECT,
      capability,
      // D1 is not what this proves, and a real migrate would want a Miniflare store.
      migrate: async () => [],
    });
  }
  // What `pithy dev` does before it starts wrangler: regenerate each Worker's `.dev.vars` from the dev
  // secrets file. This is where a `secret` binding comes from, and the reason the invariant admits a kind
  // that never appears in `wrangler.jsonc` at all.
  await writeDevVars({ projectDir: dir, values: {} });
}, 180_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One wrangler stanza, as far as this test reads it. */
interface Stanza {
  vars?: Record<string, string>;
  d1_databases?: { binding: string }[];
  kv_namespaces?: { binding: string }[];
  r2_buckets?: { binding: string }[];
  ai?: { binding: string };
  ratelimits?: { name: string }[];
  workflows?: { binding: string }[];
  durable_objects?: { bindings: { name: string }[] };
}

/**
 * The Worker env one environment's stanza produces, plus that Worker's `.dev.vars` — a stand-in for what
 * wrangler hands a running script.
 *
 * The **values** are placeholders, and that is the point: `validateBindings` asks only whether a binding
 * is there, so a placeholder proves presence without pretending to be a D1. What must not be a placeholder
 * is the **key set**, which is read out of the files the commands wrote and nowhere else.
 */
function envFromStanza(stanza: Stanza, devVars: Record<string, string>): Record<string, unknown> {
  const env: Record<string, unknown> = { ...stanza.vars, ...devVars };
  for (const entry of stanza.d1_databases ?? []) env[entry.binding] = { prepare: () => ({}) };
  for (const entry of stanza.kv_namespaces ?? []) env[entry.binding] = { get: async () => null };
  for (const entry of stanza.r2_buckets ?? []) env[entry.binding] = { get: async () => null };
  for (const entry of stanza.ratelimits ?? []) env[entry.name] = { limit: async () => ({ success: true }) };
  for (const entry of stanza.workflows ?? []) env[entry.binding] = { create: async () => ({}) };
  for (const entry of stanza.durable_objects?.bindings ?? []) env[entry.name] = { idFromName: () => ({}) };
  if (stanza.ai) env[stanza.ai.binding] = { run: async () => ({}) };
  return env;
}

test("a scaffolded project composing secrets, email and auth answers 200 on /health", async () => {
  const stanza = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as Stanza;
  const devVars = parseDevVars(await readFile(join(workerDir, ".dev.vars"), "utf8"));

  const config = await loadWorkerConfig(workerDir);
  const worker = createEntrypoint(config);
  const response = await worker.fetch(new Request("http://localhost/health"), envFromStanza(stanza, devVars), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);

  // The whole body, not just the status: a 500 here carries the binding it is missing, and that sentence
  // is the one worth reading in a failure.
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 200,
    body: { status: "ok", version: null },
  });
}, 60_000);

test("every environment's stanza carries the same bindings, so a deploy is not a second discovery", async () => {
  // The dev stanza is the one `pithy dev` reads and the one the test above boots. Staging and production
  // are read by nothing until a deploy, which is the worst moment to find a binding missing — and the
  // per-environment Workflow name means the two stanzas are not copies of each other.
  const config = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as Stanza & {
    env: Record<string, Stanza>;
  };
  const names = (stanza: Stanza): string[] =>
    [
      ...(stanza.d1_databases ?? []).map((entry) => entry.binding),
      ...(stanza.ratelimits ?? []).map((entry) => entry.name),
      ...(stanza.workflows ?? []).map((entry) => entry.binding),
    ].sort();

  expect(names(config)).toEqual(["AUTH_RATE_LIMITER", "DB", "EMAIL_SENDER", "EMAIL_SUPPRESSIONS", "SECRETS"]);
  expect(names(config.env.staging as Stanza)).toEqual(names(config));
  expect(names(config.env.prod as Stanza)).toEqual(names(config));
});

test("the Workflow entry names the environment's own host, never another environment's", async () => {
  const config = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
    workflows: { binding: string; name: string; class_name: string; script_name: string }[];
    env: Record<string, { workflows: { name: string; script_name: string }[] }>;
  };
  expect(config.workflows).toEqual([
    {
      binding: "EMAIL_SENDER",
      name: "replay-dev-email-send",
      class_name: "EmailSendWorkflow",
      script_name: "replay-dev-email",
    },
  ]);
  expect(config.env.staging?.workflows?.[0]).toMatchObject({
    name: "replay-staging-email-send",
    script_name: "replay-staging-email",
  });
});
