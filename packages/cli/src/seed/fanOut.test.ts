// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { defineSeed, kvSeedGroup } from "@pithy-sh/core/src/seed/seed";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { migrateProject } from "../migrations/run";
import { dataCapability, localWrangler, seedHarness } from "../test-utils/seedHarness";
import { seedProject } from "./run";

/**
 * `seedProject`'s fan-out across a project's workers — one of the two groups that dominated the
 * suite's wall clock, in its own file so it runs alongside the rest instead of behind it. Shared
 * scaffolding lives in `test-utils/seedHarness.ts`.
 */
describe("seedProject", () => {
  const h = seedHarness();

  describe("fan-out over workers", () => {
    /** A second worker's capability: its own seed set, writing to the KV namespace both workers bind. */
    const roomsStore = {
      prefix: "rooms",
      key: z.object({ id: z.string().describe("The room's id segment.") }),
      value: z.object({ title: z.string().describe("The room's title.") }),
    };

    function collabCapability() {
      return defineCapability({
        name: "collab",
        requiredBindings: [],
        kvNamespaces: { cache: { binding: "CACHE", stores: { rooms: roomsStore } } },
        seeds: [
          defineSeed({
            name: "rooms",
            order: 2000,
            environments: ["dev"],
            kv: [kvSeedGroup("cache", "rooms", roomsStore, [{ key: { id: "r1" }, value: { title: "Room" } }])],
          }),
        ],
      });
    }

    test("runs each worker's own fixtures and reports per worker", async () => {
      await h.writeWrangler(localWrangler);
      const workers = [h.api([dataCapability()]), await h.worker("collab", [collabCapability()])];
      await migrateProject({ projectDir: h.projectDir, workers, env: "dev", project: "acme" });

      const report = await seedProject({ project: "acme", projectDir: h.projectDir, workers, env: "dev" });
      expect(report.workers.map((entry) => entry.worker)).toEqual(["api", "collab"]);
      expect(report.workers[0]?.sets.map((set) => set.name)).toEqual(["1000_app_demo"]);
      expect(report.workers[1]?.sets).toEqual([
        {
          name: "2000_collab_rooms",
          d1: [],
          kv: [{ namespace: "cache", store: "rooms", entries: 1 }],
          r2: [],
          media: [],
        },
      ]);
      expect(report.workers.every((entry) => entry.shared.length === 0)).toBe(true);

      // Both workers bind CACHE, so both fixtures landed in the one project-root KV store.
      const store = await h.openLocal();
      try {
        expect(await store.kv.get("notes:a")).toBe(JSON.stringify({ body: "hello" }));
        expect(await store.kv.get("rooms:r1")).toBe(JSON.stringify({ title: "Room" }));
      } finally {
        await store.dispose();
      }
    });

    test("a set two workers compose runs once, and the second worker says so", async () => {
      await h.writeWrangler(localWrangler);
      const workers = [h.api([dataCapability()]), await h.worker("collab", [dataCapability()])];
      await migrateProject({ projectDir: h.projectDir, workers, env: "dev", project: "acme" });

      const report = await seedProject({ project: "acme", projectDir: h.projectDir, workers, env: "dev" });
      expect(report.workers[0]?.sets.map((set) => set.name)).toEqual(["1000_app_demo"]);
      expect(report.workers[1]?.sets).toEqual([]);
      expect(report.workers[1]?.shared).toEqual(["1000_app_demo"]);

      const store = await h.openLocal();
      try {
        const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2); // written once, not once per worker
      } finally {
        await store.dispose();
      }
    });

    test("a set two workers point at different databases runs in each of them", async () => {
      // Same capability, same binding name, different resolved databases — a wiring `migrate` supports
      // and migrates separately. Deduping on the set key alone would skip the second store and report
      // it as "already seeded by another worker", leaving that database empty and saying otherwise.
      await h.writeWrangler(localWrangler);
      const collab = await h.worker("collab", [dataCapability()], {
        d1_databases: [{ binding: "DB", database_id: "db-collab" }],
        kv_namespaces: [{ binding: "CACHE", id: "cache-collab" }],
      });
      const workers = [h.api([dataCapability()]), collab];
      await migrateProject({ projectDir: h.projectDir, workers, env: "dev", project: "acme" });

      const report = await seedProject({ project: "acme", projectDir: h.projectDir, workers, env: "dev" });
      expect(report.workers[1]?.shared).toEqual([]);
      expect(report.workers[1]?.sets.map((set) => set.name)).toEqual(["1000_app_demo"]);

      const mf = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { API: "db-local", COLLAB: "db-collab" },
        d1Persist: join(h.projectDir, ".wrangler", "state", "v3", "d1"),
      });
      try {
        for (const binding of ["API", "COLLAB"]) {
          const db = (await mf.getD1Database(binding)) as unknown as D1Database;
          const count = await db.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
          expect(count?.n, `${binding} rows`).toBe(2);
        }
      } finally {
        await mf.dispose();
      }
    });

    test("--worker narrows the fan-out to one worker", async () => {
      await h.writeWrangler(localWrangler);
      const workers = [h.api([dataCapability()]), await h.worker("collab", [collabCapability()])];
      await migrateProject({ projectDir: h.projectDir, workers, env: "dev", project: "acme" });

      const report = await seedProject({
        project: "acme",
        projectDir: h.projectDir,
        workers,
        env: "dev",
        worker: "collab",
      });
      expect(report.workers.map((entry) => entry.worker)).toEqual(["collab"]);

      const store = await h.openLocal();
      try {
        expect(await store.kv.get("rooms:r1")).toBe(JSON.stringify({ title: "Room" }));
        // The unnamed worker's fixtures never ran.
        expect(await store.kv.get("notes:a")).toBeNull();
      } finally {
        await store.dispose();
      }
    });

    test("a dry run plans per worker too, writing nothing", async () => {
      await h.writeWrangler(localWrangler);
      const workers = [h.api([dataCapability()]), await h.worker("collab", [collabCapability()])];

      const report = await seedProject({
        project: "acme",
        projectDir: h.projectDir,
        workers,
        env: "dev",
        dryRun: true,
      });
      expect(report).toMatchObject({
        command: "seed",
        env: "dev",
        dryRun: true,
        workers: [
          { worker: "api", skippedByEnv: [], shared: [] },
          { worker: "collab", skippedByEnv: [], shared: [] },
        ],
      });
      expect(report.workers[1]?.sets.map((set) => set.name)).toEqual(["2000_collab_rooms"]);
    });
  });
});
