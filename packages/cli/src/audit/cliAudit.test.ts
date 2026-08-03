// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCliAudit, createRemoteCliAudit, isRemoteEnv, resolveAuditDatabaseId } from "./cliAudit";

/** Clients that would explode if touched — auditing must not reach for them when it is inert. */
const unusedClients = {
  d1: () => {
    throw new Error("must not resolve a D1 when auditing is unavailable");
  },
  user: () => {
    throw new Error("must not resolve an actor when auditing is unavailable");
  },
} as unknown as CloudflareClients;

/** Write a Worker's `apps/<name>/wrangler.jsonc`, as the per-Worker layout has it. */
async function writeWorker(projectDir: string, name: string, config: unknown): Promise<string> {
  const dir = join(projectDir, "apps", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify(config));
  return dir;
}

describe("resolveAuditDatabaseId", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-cliaudit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads a worker's top-level DB binding for dev and its env stanza otherwise", async () => {
    await writeWorker(dir, "api", {
      name: "api",
      d1_databases: [{ binding: "DB", database_id: "local-db" }],
      env: { staging: { d1_databases: [{ binding: "DB", database_id: "staging-db" }] } },
    });

    expect(await resolveAuditDatabaseId(dir, "dev")).toBe("local-db");
    expect(await resolveAuditDatabaseId(dir, "staging")).toBe("staging-db");
  });

  test("is undefined when the env, the binding, or the worker is absent", async () => {
    expect(await resolveAuditDatabaseId(dir, "dev")).toBeUndefined(); // no workers at all

    await writeWorker(dir, "api", { name: "api", d1_databases: [{ binding: "OTHER", id: "x" }] });
    expect(await resolveAuditDatabaseId(dir, "dev")).toBeUndefined();
    expect(await resolveAuditDatabaseId(dir, "nope")).toBeUndefined();
  });

  test("takes the first worker declaring DB, and honours an explicit worker name", async () => {
    // `web` sorts first and binds no database; `api` holds the app DB. Workers share a resource by
    // declaring the same binding name, so the first DB found IS the app database — no ambiguity error,
    // because auditing must never break the command it records.
    await writeWorker(dir, "web", { name: "web" });
    await writeWorker(dir, "api", { name: "api", d1_databases: [{ binding: "DB", database_id: "app-db" }] });

    expect(await resolveAuditDatabaseId(dir, "dev")).toBe("app-db");
    expect(await resolveAuditDatabaseId(dir, "dev", "api")).toBe("app-db");
    expect(await resolveAuditDatabaseId(dir, "dev", "web")).toBeUndefined();
  });
});

describe("createCliAudit", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-cliaudit-"));
    await writeWorker(dir, "api", { name: "api", d1_databases: [{ binding: "DB", database_id: "x" }] });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const audit = defineCapability({ name: "audit", requiredBindings: [] });
  const app = defineCapability({ name: "app", requiredBindings: [] });

  test("createRemoteCliAudit never audits a local dev run, even with audit composed", async () => {
    // Only actions that reach a remote system are recorded — from a developer's machine, from CI, or in
    // production. A `dev` run touches local Miniflare and nothing shared. It must not even *try*: `dev`
    // resolves to the top-level database_id, a REAL remote database, written through the REST client — so
    // auditing it would be a credentialed network write into a database the action never touched. The
    // stand-in clients throw if touched, proving nothing is resolved.
    const emit = await createRemoteCliAudit({
      projectDir: dir,
      env: "dev",
      capabilities: [audit, app],
      clients: unusedClients,
      apiToken: "tok",
    });

    await expect(emit({ action: "seed/schema_reset", outcome: "success" })).resolves.toBeUndefined();
  });

  test("isRemoteEnv marks only dev as local", () => {
    expect(isRemoteEnv("dev")).toBe(false);
    for (const env of ["staging", "prod", "feature", "prod-eu"]) {
      expect(isRemoteEnv(env)).toBe(true);
    }
  });

  test("is a no-op — and touches no client — when the project does not compose audit", async () => {
    const emit = await createCliAudit({
      projectDir: dir,
      env: "dev",
      capabilities: [app],
      clients: unusedClients,
      apiToken: "tok",
    });

    // Always callable: a call site never needs an `if (audit)` branch.
    await expect(emit({ action: "feature/resource_deleted", outcome: "success" })).resolves.toBeUndefined();
  });

  test("is a no-op when the environment's audit database cannot be resolved", async () => {
    const emit = await createCliAudit({
      projectDir: dir,
      env: "staging", // no env.staging stanza in this wrangler.jsonc
      capabilities: [audit, app],
      clients: unusedClients,
      apiToken: "tok",
    });

    await expect(emit({ action: "feature/resource_deleted", outcome: "success" })).resolves.toBeUndefined();
  });
});
