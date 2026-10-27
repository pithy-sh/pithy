// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { appCapability, migrateHarness, multiplayerCapability } from "../test-utils/migrateHarness";
import { withProjectDatabases } from "./run";

/** The seam `pithy backup` and `pithy restore` open databases through (#848). */
describe("withProjectDatabases", () => {
  const h = migrateHarness();

  test("opens a database two Workers share once, naming both and every capability either composes", async () => {
    const api = h.api([appCapability()]);
    const collab = await h.worker("collab", [appCapability(), multiplayerCapability()]);
    const seen = await withProjectDatabases(
      { projectDir: h.projectDir, account: null, env: "dev", workers: [api, collab] },
      async (opened) =>
        opened.map(({ database }) => [
          database.binding,
          database.workers,
          database.capabilities.map((c) => c.name),
          database.target,
        ]),
    );
    expect(seen).toEqual([
      ["DB", ["api", "collab"], ["app", "multiplayer"], "DB"],
      ["COLLAB_DB", ["collab"], ["app", "multiplayer"], "COLLAB_DB"],
    ]);
  });

  test("a retarget points a database at another store, and --binding narrows to it", async () => {
    const api = h.api([appCapability(), multiplayerCapability()]);
    const seen = await withProjectDatabases(
      {
        projectDir: h.projectDir,
        account: null,
        env: "dev",
        workers: [api],
        binding: "DB",
        retarget: (database) => (database.binding === "DB" ? "recovery" : undefined),
      },
      async (opened) => opened.map(({ database }) => [database.binding, database.target]),
    );
    expect(seen).toEqual([["DB", "recovery"]]);
  });

  test("beforeOpen sees every database and its migrations first, and a throw there opens nothing", async () => {
    const api = h.api([appCapability(), multiplayerCapability()]);
    const seen: Array<[string, string[]]> = [];
    let opened = false;
    let retargeted = false;
    const run = withProjectDatabases(
      {
        projectDir: h.projectDir,
        account: null,
        env: "dev",
        workers: [api],
        beforeOpen: async (databases) => {
          for (const database of databases) {
            seen.push([database.binding, Object.keys(await database.provider.getMigrations())]);
          }
          throw new Error("refused");
        },
        retarget: () => {
          retargeted = true;
          return undefined;
        },
      },
      async () => {
        opened = true;
      },
    );
    await expect(run).rejects.toThrow("refused");
    expect(seen.map(([binding]) => binding)).toEqual(["DB", "COLLAB_DB"]);
    expect(seen.every(([, keys]) => keys.length > 0)).toBe(true);
    expect(retargeted).toBe(false);
    expect(opened).toBe(false);
  });
});
