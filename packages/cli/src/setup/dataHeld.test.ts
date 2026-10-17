// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { Migration } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { migrateProject } from "../migrations/run";
import { seedProject } from "../seed/run";
import { dataCapability, localWrangler, seedHarness, Things } from "../test-utils/seedHarness";
import { devDataHeld } from "./dataHeld";

/**
 * **`pithy setup` seeds dev only into a database that holds nothing (#764).** "Nothing" is judged over the
 * tables a Worker's capabilities declare, and a retained table is not one of them: the secrets vault holds the
 * dev secrets setup itself seeds a moment earlier, and a suppression list is somebody's request, not data a
 * fixture would ever write.
 */

const createVault: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("pithy_vault_items")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("name", "text", (c) => c.notNull())
      .execute();
  },
  down: async (db) => {
    await db.schema.dropTable("pithy_vault_items").execute();
  },
};

/** A capability whose one table is retained: rows in it are never what makes a database "seeded". */
const vault = defineCapability({
  name: "vault",
  requiredBindings: [],
  databases: {
    app: {
      binding: "DB",
      tables: { pithyVaultItems: Things },
      migrations: { "0001_vault": createVault },
      migrationOrder: 900,
      retained: ["pithyVaultItems"],
    },
  },
});

describe("devDataHeld", () => {
  const h = seedHarness();

  test("an unmigrated database holds nothing", async () => {
    await h.writeWrangler(localWrangler);

    expect(await devDataHeld({ projectDir: h.projectDir, workers: [h.api([dataCapability()])] })).toEqual([]);
  });

  test("a migrated, empty database holds nothing; a seeded one names the table holding rows", async () => {
    await h.writeWrangler(localWrangler);
    const workers = [h.api([dataCapability()])];
    await migrateProject({ account: null, workers, projectDir: h.projectDir, env: "dev", project: "acme" });

    expect(await devDataHeld({ projectDir: h.projectDir, workers })).toEqual([]);

    await seedProject({ account: null, project: "acme", workers, projectDir: h.projectDir, env: "dev" });

    expect(await devDataHeld({ projectDir: h.projectDir, workers })).toEqual([
      { worker: "api", binding: "DB", table: "things" },
    ]);
  });

  test("rows in a retained table are not data a seed is judged against", async () => {
    await h.writeWrangler(localWrangler);
    const workers = [h.api([vault, dataCapability()])];
    await migrateProject({ account: null, workers, projectDir: h.projectDir, env: "dev", project: "acme" });
    const store = await h.openLocal();
    try {
      await store.d1.prepare("insert into pithy_vault_items (name) values ('sealed')").run();
    } finally {
      await store.dispose();
    }

    expect(await devDataHeld({ projectDir: h.projectDir, workers })).toEqual([]);
  });

  test("two Workers on one database are asked once", async () => {
    await h.writeWrangler(localWrangler);
    const api = h.api([dataCapability()]);
    const web = await h.worker("web", [dataCapability()]);
    const workers = [api, web];
    await migrateProject({ account: null, workers, projectDir: h.projectDir, env: "dev", project: "acme" });
    await seedProject({ account: null, project: "acme", workers, projectDir: h.projectDir, env: "dev" });

    expect(await devDataHeld({ projectDir: h.projectDir, workers })).toEqual([
      { worker: "api", binding: "DB", table: "things" },
    ]);
  });
});
