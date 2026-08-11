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
  accountTokens: () => {
    throw new Error("must not resolve an actor when auditing is unavailable");
  },
} as unknown as CloudflareClients;

/**
 * A `D1Database` that answers every write and remembers what it was asked to run.
 *
 * Enough for the Kysely D1 dialect the recorder inserts through, and no more: the question these tests
 * ask is *which handle* the row went to, which needs the statement and its bindings and nothing else.
 * The row landing in a real database is covered against real D1 in `dashboard/registry.test.ts`.
 */
function capturingD1(): { database: D1Database; statements: string[]; bindings: unknown[][] } {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  const database = {
    prepare(sql: string) {
      statements.push(sql);
      const statement = {
        bind(...values: unknown[]) {
          bindings.push(values);
          return statement;
        },
        all: async () => ({ results: [], success: true, meta: {} }),
        run: async () => ({ results: [], success: true, meta: {} }),
        first: async () => null,
        raw: async () => [],
      };
      return statement;
    },
    batch: async () => [],
  } as unknown as D1Database;
  return { database, statements, bindings };
}

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

  test("hands actor resolution both Cloudflare scopes", async () => {
    const touched: string[] = [];
    const clients = {
      d1: () => ({}),
      user: () => {
        touched.push("user");
        return {};
      },
      accountTokens: () => {
        touched.push("accountTokens");
        return {};
      },
    } as unknown as CloudflareClients;

    await createCliAudit({ projectDir: dir, env: "dev", capabilities: [audit, app], clients, apiToken: "cfat_x" });

    // A `cfat_*` token — the kind `pithy token mint` produces — is rejected by every `/user/*` endpoint,
    // so the account scope has to reach the resolver. Handed only `user()`, it attributed every account
    // token to `system`, silently, because resolution failure is never fatal.
    expect([...touched].sort()).toEqual(["accountTokens", "user"]);
  });

  test("an injected database is written to, and no id is ever looked up", async () => {
    // #294. `pithy dashboard` already holds the adopter's database open — the one the connection row was
    // just written through — and the event has to land in *that* one. On `dev` a resolved id names the
    // real remote database while the row went to local Miniflare, so a second lookup would record the
    // change in a store nothing touched.
    //
    // Both halves are asserted at once: `staging` has no stanza here, so a lookup would resolve nothing
    // and leave an inert emitter, and `unusedClients` throws if `d1()` is reached at all. A statement
    // arriving at the injected handle proves neither happened.
    // Actor resolution legitimately still runs, so only `d1()` is the forbidden call here.
    const clients = {
      d1: () => {
        throw new Error("must not resolve a database when one was injected");
      },
      user: () => ({}),
      accountTokens: () => ({}),
    } as unknown as CloudflareClients;

    const { database, statements } = capturingD1();
    const emit = await createCliAudit({
      projectDir: dir,
      env: "staging",
      capabilities: [audit, app],
      clients,
      apiToken: "cfat_x",
      database,
    });
    await emit({ action: "controlplane/connection_registered", outcome: "success" });

    expect(statements.some((sql) => sql.includes("pithy_audit_events"))).toBe(true);
  });

  test("records without Cloudflare credentials, unattributed rather than dropped", async () => {
    // A `dev` connect touches no Cloudflare account, so requiring an account token to record it would
    // make the trail depend on something the action does not. The union type is what keeps this from
    // loosening the ordinary case: dropping `clients` without injecting a database does not compile.
    const { database, bindings, statements } = capturingD1();
    const emit = await createCliAudit({ projectDir: dir, env: "dev", capabilities: [audit, app], database });
    await emit({ action: "controlplane/connection_registered", outcome: "success" });

    expect(statements.some((sql) => sql.includes("pithy_audit_events"))).toBe(true);
    // `system` with a note, deliberately the shape `resolveActor` falls back to, so one filter finds
    // every unattributed row. Unnamed is the true answer here; dropping the row is not.
    expect(bindings.flat()).toContain("system");
    expect(JSON.stringify(bindings)).toContain("actorResolutionFailed");
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
