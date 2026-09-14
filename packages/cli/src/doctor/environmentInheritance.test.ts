// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkEnvironmentInheritance, describeEnvironmentInheritance } from "./environmentInheritance";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-inheritance-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One Worker under `apps/<name>/wrangler.jsonc`, written as the adopter would write it. */
async function worker(name: string, config: Record<string, unknown>): Promise<void> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: `acme-${name}`, ...config }, null, 2));
}

/** The stanza shape the starter ships, minus whatever a test is proving the absence of. */
const STANZA = { vars: { ENVIRONMENT: "staging" }, version_metadata: { binding: "CF_VERSION_METADATA" } };

describe("checkEnvironmentInheritance", () => {
  test("names the key, the environment and the binding that environment goes without", async () => {
    await worker("api", {
      observability: { enabled: true, head_sampling_rate: 1 },
      version_metadata: { binding: "CF_VERSION_METADATA" },
      vars: { ENVIRONMENT: "dev" },
      env: {
        staging: { vars: { ENVIRONMENT: "staging" } },
        prod: { vars: { ENVIRONMENT: "prod" } },
      },
    });
    const check = await checkEnvironmentInheritance(dir);
    expect(check.state).toBe("unrepeated");
    expect(check.unrepeated).toEqual([
      { worker: "api", env: "staging", key: "version_metadata", carries: ["CF_VERSION_METADATA"] },
      { worker: "api", env: "prod", key: "version_metadata", carries: ["CF_VERSION_METADATA"] },
    ]);
    const lines = describeEnvironmentInheritance(check);
    expect(lines[0]).toContain("api");
    expect(lines[0]).toContain("version_metadata");
    expect(lines[0]).toContain("env.staging");
    expect(lines[0]).toContain("CF_VERSION_METADATA");
  });

  test("an inherited key at the top level and nowhere else is not a finding", async () => {
    // The correction that reshaped #581. `observability` and `triggers` are inherited: an environment
    // that does not repeat them still has them, and a line saying otherwise is a line that is wrong.
    await worker("api", {
      observability: { enabled: true },
      triggers: { crons: ["0 * * * *"] },
      env: { staging: STANZA, prod: STANZA },
    });
    expect(await checkEnvironmentInheritance(dir)).toEqual({ state: "ok", unrepeated: [] });
  });

  test("a stanza that repeats everything is clean", async () => {
    await worker("api", {
      version_metadata: { binding: "CF_VERSION_METADATA" },
      vars: { ENVIRONMENT: "dev" },
      d1_databases: [{ binding: "DB", database_name: "acme-dev" }],
      env: {
        staging: { ...STANZA, d1_databases: [{ binding: "DB", database_name: "acme-staging" }] },
      },
    });
    expect(await checkEnvironmentInheritance(dir)).toEqual({ state: "ok", unrepeated: [] });
  });

  test("an empty collection at the top level costs an environment nothing", async () => {
    // The judgment call, stated as a test. Wrangler warns on this; doctor does not, because there is no
    // cost to name — and this is the shape every scaffolded project ships with.
    await worker("api", { d1_databases: [], kv_namespaces: [], env: { staging: {}, prod: {} } });
    expect(await checkEnvironmentInheritance(dir)).toEqual({ state: "ok", unrepeated: [] });
  });

  test("every Worker in the project is read, not just the first", async () => {
    await worker("api", { env: { staging: STANZA } });
    await worker("admin", {
      version_metadata: { binding: "CF_VERSION_METADATA" },
      env: { staging: { vars: { ENVIRONMENT: "staging" } } },
    });
    const check = await checkEnvironmentInheritance(dir);
    expect(check.unrepeated.map((one) => one.worker)).toEqual(["admin"]);
  });

  test("a Worker with no environments has nothing to repeat", async () => {
    await worker("api", { version_metadata: { binding: "CF_VERSION_METADATA" } });
    expect(await checkEnvironmentInheritance(dir)).toEqual({ state: "ok", unrepeated: [] });
  });

  test("a wrangler.jsonc that will not parse is could-not-check, never ok", async () => {
    // The state that must not be silent. An unreadable config establishes nothing, and a report that
    // said `ok` would be telling the reader their environments are fine on evidence it never had.
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), "{ this is not json");
    expect(await checkEnvironmentInheritance(dir)).toEqual({ state: "could-not-check", unrepeated: [] });
  });

  test("a directory with no Workers has no stanza to be wrong about", async () => {
    // `ok` rather than `could-not-check`: nothing failed to be read. Doctor only runs this inside a
    // project anyway, and `checkEnvironments` answers an empty `apps/` the same way.
    expect(await checkEnvironmentInheritance(join(dir, "nowhere"))).toEqual({ state: "ok", unrepeated: [] });
  });

  test("a finding is still reported when another Worker could not be read", async () => {
    // The reach rule: one unreadable file must not swallow the finding beside it.
    await worker("api", {
      version_metadata: { binding: "CF_VERSION_METADATA" },
      env: { staging: { vars: { ENVIRONMENT: "staging" } } },
    });
    const broken = join(dir, "apps", "broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "wrangler.jsonc"), "{ nope");
    const check = await checkEnvironmentInheritance(dir);
    expect(check.unrepeated).toHaveLength(1);
    expect(check.state).toBe("unrepeated");
  });

  test("says nothing at all when there is nothing to say", () => {
    expect(describeEnvironmentInheritance({ state: "ok", unrepeated: [] })).toEqual([]);
  });
});
