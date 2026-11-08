// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { stringify } from "comment-json";
import { describe, expect, test } from "vitest";
import { appendBinding, type WranglerStanza } from "../project/bindingEntries";
import { createTable, migrateHarness, withLocalD1 } from "../test-utils/migrateHarness";
import { migrateProject } from "./run";

/**
 * **Two Workers, one binding name, two databases — locally, with no hand edit.** `pithy add` writes the stanza an
 * owned D1 binding gets, a `database_id` of its own at the top level; `pithy migrate` keys a local store on it, so
 * each Worker's migrations land in its own database and neither sees the other's tables.
 */

/** A Worker's app capability: one database on `DB`, one table of its own. */
function product(table: string): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    databases: {
      app: { binding: "DB", tables: {}, migrations: { [`0001_${table}`]: createTable(table) }, migrationOrder: 1000 },
    },
  });
}

/** The top-level stanza `pithy add` writes for `DB` in `apps/<worker>`, owned or shared. */
async function scaffold(workerDir: string, worker: string, owns: boolean): Promise<void> {
  const config: WranglerStanza = {};
  appendBinding(config, BindingSpec.parse({ type: "d1", name: "DB" }), {
    project: "my-app",
    env: "dev",
    capability: "app",
    ...(owns ? { owns: { worker, bindings: new Set(["DB"]) }, topLevel: true } : {}),
  });
  await writeFile(join(workerDir, "wrangler.jsonc"), stringify({ name: `my-app-${worker}`, ...config }, null, 2));
}

async function tables(projectDir: string, store: string): Promise<string[]> {
  return withLocalD1(projectDir, store, async (db) => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('orders', 'plans') ORDER BY name")
      .all<{ name: string }>();
    return results.map((row) => row.name);
  });
}

describe("pithy migrate for an owned D1 binding", () => {
  const h = migrateHarness();

  test("lands each Worker's migrations in its own local database", async () => {
    const api = h.api([product("orders")]);
    const other = await h.worker("other", [product("plans")]);
    await scaffold(api.dir, "api", false);
    await scaffold(other.dir, "other", true);

    const runs = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers: [api, other],
      env: "dev",
      project: "my-app",
    });

    expect(runs.map((run) => run.databases[0]?.results.map((result) => result.migrationName))).toEqual([
      ["1000_app_0001_orders"],
      ["1000_app_0001_plans"],
    ]);
    // Not shared: two databases behind one binding name.
    expect(runs.map((run) => run.databases[0]?.sharedWith)).toEqual([undefined, undefined]);
    // api's database is the shared store, keyed on the binding; other's is keyed on its own id.
    expect(await tables(h.projectDir, "DB")).toEqual(["orders"]);
    expect(await tables(h.projectDir, "my-app-dev-other---db")).toEqual(["plans"]);
  });
});
