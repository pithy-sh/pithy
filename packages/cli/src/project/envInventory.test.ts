// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildEnvInventory } from "./envInventory";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-env-inv-"));
  // Keep the account id deterministic regardless of the ambient environment.
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** Write one Worker under `apps/<name>/` with the given wrangler.jsonc. Discovery keys on that file. */
async function writeWorker(name: string, config: unknown): Promise<string> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify(config, null, 2));
  return workerDir;
}

/** The single-Worker fixture most tests use: `apps/api` with the given wrangler.jsonc. */
async function writeWrangler(config: unknown): Promise<void> {
  await writeWorker("api", config);
}

async function writeAccountId(id: string): Promise<void> {
  await writeFile(join(dir, ".dev.vars"), `CLOUDFLARE_ACCOUNT_ID=${id}\n`);
}

/** The first (or only) Worker's environments. */
async function environmentsOf(worker = 0) {
  const inv = await buildEnvInventory({ projectDir: dir });
  return inv.workers[worker]?.environments ?? [];
}

describe("buildEnvInventory", () => {
  test("a project with no workers throws a NotFoundError with an action", async () => {
    await expect(buildEnvInventory({ projectDir: dir })).rejects.toMatchObject({
      payload: { code: "core/not_found", action: expect.any(String) },
    });
    await expect(buildEnvInventory({ projectDir: dir })).rejects.toBeInstanceOf(PithyError);
  });

  test("enumerates dev (top-level) plus every env.<name>", async () => {
    await writeWrangler({
      name: "pithy-app",
      d1_databases: [],
      env: { staging: {}, production: {} },
    });
    const inv = await buildEnvInventory({ projectDir: dir });
    expect(inv.workers).toHaveLength(1);
    expect(inv.workers[0]).toMatchObject({ worker: "pithy-app", dir: join("apps", "api") });
    const environments = inv.workers[0]?.environments ?? [];
    expect(environments.map((e) => e.name)).toEqual(["dev", "staging", "production"]);
    expect(environments[0]?.baseUrl).toBe("local");
    expect(environments[0]?.scriptName).toBe("pithy-app");
  });

  test("a d1 binding with an id is provisioned and gets a dashboard link", async () => {
    await writeAccountId("acct-9");
    await writeWrangler({
      name: "pithy-app",
      d1_databases: [{ binding: "DB", database_id: "db-uuid" }],
    });
    const inv = await buildEnvInventory({ projectDir: dir });
    expect(inv.accountId).toBe("acct-9");
    const dev = inv.workers[0]?.environments[0];
    expect(dev?.resources[0]).toMatchObject({
      kind: "d1",
      binding: "DB",
      id: "db-uuid",
      provisioned: true,
      dashboardUrl: "https://dash.cloudflare.com/acct-9/workers/d1/databases/db-uuid/metrics",
    });
    expect(dev?.workerDashboardUrl).toBe(
      "https://dash.cloudflare.com/acct-9/workers/services/view/pithy-app/production",
    );
  });

  test("a binding with no id is not provisioned and has no link", async () => {
    await writeAccountId("acct-9");
    await writeWrangler({ name: "pithy-app", d1_databases: [{ binding: "DB" }] });
    expect((await environmentsOf())[0]?.resources[0]).toMatchObject({
      provisioned: false,
      id: null,
      dashboardUrl: null,
    });
  });

  test("a placeholder id is not provisioned", async () => {
    await writeAccountId("acct-9");
    await writeWrangler({ name: "pithy-app", kv_namespaces: [{ binding: "SESSIONS", id: "<namespace_id>" }] });
    expect((await environmentsOf())[0]?.resources[0]).toMatchObject({
      kind: "kv",
      provisioned: false,
      dashboardUrl: null,
    });
  });

  test("resolves kv and r2 id fields and links them", async () => {
    await writeAccountId("acct-9");
    await writeWrangler({
      name: "pithy-app",
      kv_namespaces: [{ binding: "SESSIONS", id: "ns-1" }],
      r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
    });
    const resources = (await environmentsOf())[0]?.resources ?? [];
    expect(resources.find((r) => r.kind === "kv")?.dashboardUrl).toBe(
      "https://dash.cloudflare.com/acct-9/workers/kv/namespaces/ns-1/metrics",
    );
    expect(resources.find((r) => r.kind === "r2")?.dashboardUrl).toBe(
      "https://dash.cloudflare.com/acct-9/r2/default/buckets/media",
    );
  });

  test("durable-object bindings report by class name and link to the DO list page", async () => {
    // The DO dashboard route exists and is verified, but it addresses a namespace id Cloudflare assigns
    // when the Worker deploys — never the class name wrangler.jsonc carries. Building a deep link from a
    // class name would produce an authoritative-looking 404, so the inventory shows the class and links to
    // the Durable Objects list, which is one click away and always correct.
    await writeAccountId("acct-9");
    await writeWrangler({
      name: "pithy-app",
      durable_objects: { bindings: [{ name: "ROOM", class_name: "GameRoom" }] },
    });
    const resource = (await environmentsOf())[0]?.resources[0];
    expect(resource).toMatchObject({
      kind: "durable_object",
      binding: "ROOM",
      id: "GameRoom",
      provisioned: true,
      dashboardUrl: "https://dash.cloudflare.com/acct-9/workers/durable-objects",
    });
    // Specifically: the class name never appears in a URL.
    expect(resource?.dashboardUrl ?? "").not.toContain("GameRoom");
  });

  test("no account id: full inventory, every dashboard link omitted", async () => {
    await writeWrangler({
      name: "pithy-app",
      d1_databases: [{ binding: "DB", database_id: "db-uuid" }],
    });
    const inv = await buildEnvInventory({ projectDir: dir });
    expect(inv.accountId).toBeNull();
    expect(inv.workers[0]?.environments[0]?.workerDashboardUrl).toBeNull();
    expect(inv.workers[0]?.environments[0]?.resources[0]).toMatchObject({ provisioned: true, dashboardUrl: null });
  });

  test("derives a base URL from the first route pattern of a named env", async () => {
    await writeWrangler({
      name: "pithy-app",
      env: { production: { name: "pithy-app-production", routes: [{ pattern: "api.example.com/*" }] } },
    });
    const prod = (await environmentsOf()).find((e) => e.name === "production");
    expect(prod?.baseUrl).toBe("https://api.example.com");
    expect(prod?.scriptName).toBe("pithy-app-production");
  });

  test("a named env with no route has a null base URL", async () => {
    await writeWrangler({ name: "pithy-app", env: { staging: {} } });
    expect((await environmentsOf()).find((e) => e.name === "staging")?.baseUrl).toBeNull();
  });
});

describe("buildEnvInventory — per Worker", () => {
  test("inventories every worker, each from its own wrangler.jsonc", async () => {
    await writeAccountId("acct-9");
    await writeWorker("api", {
      name: "acme-api",
      d1_databases: [{ binding: "DB", database_id: "db-uuid" }],
      env: { production: { name: "acme-api-production" } },
    });
    await writeWorker("collab", {
      name: "acme-collab",
      kv_namespaces: [{ binding: "PRESENCE", id: "ns-2" }],
    });

    const inv = await buildEnvInventory({ projectDir: dir });
    expect(inv.workers.map((worker) => worker.worker)).toEqual(["acme-api", "acme-collab"]);
    expect(inv.workers[0]?.environments.map((e) => e.name)).toEqual(["dev", "production"]);
    expect(inv.workers[1]?.environments.map((e) => e.name)).toEqual(["dev"]);
    expect(inv.workers[1]?.environments[0]?.resources[0]).toMatchObject({ kind: "kv", binding: "PRESENCE" });
    // Each worker's directory is reported project-relative, so the report reads the same anywhere.
    expect(inv.workers.map((worker) => worker.dir)).toEqual([join("apps", "api"), join("apps", "collab")]);
  });

  test("--worker narrows to one, by name or by apps/<dir> basename", async () => {
    await writeWorker("api", { name: "acme-api" });
    await writeWorker("collab", { name: "acme-collab" });

    const byName = await buildEnvInventory({ projectDir: dir, worker: "acme-collab" });
    expect(byName.workers.map((worker) => worker.worker)).toEqual(["acme-collab"]);

    const byDir = await buildEnvInventory({ projectDir: dir, worker: "collab" });
    expect(byDir.workers.map((worker) => worker.worker)).toEqual(["acme-collab"]);
  });

  test("an unknown --worker names the known ones", async () => {
    await writeWorker("api", { name: "acme-api" });
    await expect(buildEnvInventory({ projectDir: dir, worker: "nope" })).rejects.toMatchObject({
      payload: { code: "core/not_found", action: expect.stringContaining("acme-api") },
    });
  });

  test("a dev-set process with no wrangler.jsonc has no environments and is skipped", async () => {
    await writeWorker("api", { name: "acme-api" });
    const webDir = join(dir, "apps", "web");
    await mkdir(webDir, { recursive: true });
    await writeFile(join(webDir, "pithy.worker.jsonc"), JSON.stringify({ dev: { autostart: true } }));

    const inv = await buildEnvInventory({ projectDir: dir });
    expect(inv.workers.map((worker) => worker.worker)).toEqual(["acme-api"]);
  });
});
