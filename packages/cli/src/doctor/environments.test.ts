// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkEnvironments, describeEnvironmentDrift } from "./environments";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-environments-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The root config, with or without a declaration. */
async function project(declaration?: string): Promise<void> {
  const environments = declaration === undefined ? "" : `, environments: ${declaration}`;
  await writeFile(join(dir, "pithy.config.ts"), `export default { name: "acme"${environments} };\n`);
}

/** One Worker under `apps/<name>/wrangler.jsonc`. */
async function worker(name: string, env: Record<string, unknown>): Promise<void> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: `acme-${name}`, env }, null, 2));
}

/** The stanza a scaffolded, unprovisioned environment carries: bindings declared, no ids. */
const UNPROVISIONED = { d1_databases: [], kv_namespaces: [] };

describe("checkEnvironments", () => {
  test("a scaffolded project on the default set agrees with itself", async () => {
    await project();
    await worker("api", { staging: UNPROVISIONED, prod: UNPROVISIONED });
    expect(await checkEnvironments(dir)).toEqual({ state: "ok", declared: ["staging", "prod"], drift: [] });
  });

  test("a declared custom set agrees when the Worker declares the same stanzas", async () => {
    await project('["staging", "live"]');
    await worker("api", { staging: UNPROVISIONED, live: UNPROVISIONED });
    expect((await checkEnvironments(dir)).state).toBe("ok");
  });

  test("reports a Worker whose stanzas the declaration does not cover", async () => {
    await project('["staging", "live"]');
    await worker("api", { staging: {}, prod: {} });
    const check = await checkEnvironments(dir);
    expect(check.state).toBe("drifted");
    expect(check.drift).toEqual([
      { worker: "api", env: "prod", kind: "undeclared", resources: [] },
      { worker: "api", env: "live", kind: "missing", resources: [] },
    ]);
  });

  test("a declaration changed after provisioning is an orphan, not a disagreement", async () => {
    // The ids are the evidence: resources exist under a name the project no longer claims, and nothing
    // renames them. `<project>-<env>-<thing>` is recomputed, never stored.
    await project('["staging", "live"]');
    await worker("api", {
      staging: UNPROVISIONED,
      live: UNPROVISIONED,
      prod: { d1_databases: [{ binding: "DB", database_id: "db-0001" }] },
    });
    const check = await checkEnvironments(dir);
    expect(check.drift).toEqual([{ worker: "api", env: "prod", kind: "orphaned", resources: ["d1 db-0001"] }]);
    expect(describeEnvironmentDrift(check.drift[0] as never, check.declared)).toContain("orphaned");
  });

  test("a stanza whose bindings carry no ids is not provisioned, not broken", async () => {
    // The migration case #241 names: an existing project's scaffolded stanzas assert no resource, so an
    // undeclared one is a disagreement to fix, never an orphan to hunt in Cloudflare.
    await project('["staging"]');
    await worker("api", { staging: {}, prod: { d1_databases: [{ binding: "DB", database_name: "acme-prod-db" }] } });
    const check = await checkEnvironments(dir);
    expect(check.drift.map((entry) => entry.kind)).toEqual(["undeclared"]);
  });

  test("two Workers that disagree with each other are each reported against the declaration", async () => {
    await project();
    await worker("api", { staging: {}, prod: {} });
    await worker("admin", { staging: {} });
    const check = await checkEnvironments(dir);
    expect(check.drift).toEqual([{ worker: "admin", env: "prod", kind: "missing", resources: [] }]);
  });

  test("an unreadable wrangler.jsonc establishes nothing rather than failing the run", async () => {
    await project();
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), "{ not json");
    expect((await checkEnvironments(dir)).state).toBe("could-not-check");
  });

  test("a root config that will not load establishes nothing — the Project block owns that fault", async () => {
    await worker("api", { staging: {}, prod: {} });
    expect(await checkEnvironments(dir)).toEqual({ state: "could-not-check", declared: [], drift: [] });
  });

  test("a config whose declaration is illegal establishes nothing here either", async () => {
    await project('["dev", "prod"]');
    await worker("api", { staging: {}, prod: {} });
    expect((await checkEnvironments(dir)).state).toBe("could-not-check");
  });
});
