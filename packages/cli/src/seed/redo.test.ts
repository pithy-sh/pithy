// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Migration } from "kysely/migration";
import { describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { migrateProject } from "../migrations/run";
import { dataCapability, localWrangler, seedHarness, Things } from "../test-utils/seedHarness";
import { seedProject } from "./run";
import { resetConfirmPhrase } from "./safety";

/**
 * `pithy seed --redo` — the destructive reset path, and the heaviest group in the seed suite, in
 * its own file. Shared scaffolding lives in `test-utils/seedHarness.ts`.
 */
describe("seedProject", () => {
  const h = seedHarness();

  describe("--redo", () => {
    test("a plain re-seed does not refresh a changed fixture value", async () => {
      await h.writeWrangler(localWrangler);
      const capabilities = [dataCapability()];
      await migrateProject({
        account: null,
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
        project: "acme",
      });
      await seedProject({
        account: null,
        project: "acme",
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
      });

      const edited = [
        dataCapability(
          ["dev", "staging"],
          [
            { id: 1, name: "ONE-CHANGED" },
            { id: 2, name: "two" },
          ],
        ),
      ];
      await seedProject({
        account: null,
        project: "acme",
        workers: [h.api(edited)],
        projectDir: h.projectDir,
        env: "dev",
      });

      const store = await h.openLocal();
      try {
        const row = await store.d1.prepare("SELECT name FROM things WHERE id = 1").first<{ name: string }>();
        expect(row?.name).toBe("one"); // untouched — INSERT OR IGNORE never overwrites
        const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2); // no duplicate row either
      } finally {
        await store.dispose();
      }
    });

    test("refreshes a changed fixture value: the new value lands, with no duplicate row", async () => {
      await h.writeWrangler(localWrangler);
      const capabilities = [dataCapability()];
      await migrateProject({
        account: null,
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
        project: "acme",
      });
      await seedProject({
        account: null,
        project: "acme",
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
      });

      const edited = [
        dataCapability(
          ["dev", "staging"],
          [
            { id: 1, name: "ONE-CHANGED" },
            { id: 2, name: "two" },
          ],
        ),
      ];
      const report = await seedProject({
        account: null,
        project: "acme",
        workers: [h.api(edited)],
        projectDir: h.projectDir,
        env: "dev",
        redo: true,
      });
      expect(report.reset).toEqual([{ database: "app", binding: "DB", migrations: 1 }]);

      const store = await h.openLocal();
      try {
        const row = await store.d1.prepare("SELECT name FROM things WHERE id = 1").first<{ name: string }>();
        expect(row?.name).toBe("ONE-CHANGED");
        const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2);
      } finally {
        await store.dispose();
      }
    });

    test("drops and recreates the schema — a hand-inserted row is gone afterwards", async () => {
      await h.writeWrangler(localWrangler);
      const capabilities = [dataCapability()];
      await migrateProject({
        account: null,
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
        project: "acme",
      });
      await seedProject({
        account: null,
        project: "acme",
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
      });

      let store = await h.openLocal();
      try {
        await store.d1.prepare("INSERT INTO things (id, name) VALUES (999, 'hand-inserted')").run();
      } finally {
        await store.dispose();
      }

      await seedProject({
        account: null,
        project: "acme",
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
        redo: true,
      });

      store = await h.openLocal();
      try {
        // This is a full schema reset, not a per-row merge: the hand-inserted row is gone along with
        // everything else, and only the fixture's own rows come back.
        const survivor = await store.d1.prepare("SELECT count(*) AS n FROM things WHERE id = 999").first<{
          n: number;
        }>();
        expect(survivor?.n).toBe(0);
        const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2);
      } finally {
        await store.dispose();
      }
    });

    test("--dry-run reports the reset and writes nothing", async () => {
      await h.writeWrangler(localWrangler);
      const capabilities = [dataCapability()];
      await migrateProject({
        account: null,
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
        project: "acme",
      });
      await seedProject({
        account: null,
        project: "acme",
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
      });

      const report = await seedProject({
        account: null,
        project: "acme",
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
        redo: true,
        dryRun: true,
      });
      expect(report.dryRun).toBe(true);
      expect(report.reset).toEqual([{ database: "app", binding: "DB", migrations: 1 }]);

      const store = await h.openLocal();
      try {
        const count = await store.d1.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
        expect(count?.n).toBe(2); // untouched — exactly what the earlier plain seed wrote
      } finally {
        await store.dispose();
      }
    });

    test("on a non-dev env without --yes throws a PithyError — the gate is never weaker", async () => {
      await h.writeWrangler(localWrangler);
      const failure = await seedProject({
        account: null,
        project: "acme",
        workers: [h.api([dataCapability()])],
        projectDir: h.projectDir,
        env: "staging",
        redo: true,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/confirmation/i);
    });

    test("--yes alone cannot authorize a non-dev reset — that flag only ever authorizes an additive seed", async () => {
      await h.writeWrangler(localWrangler);
      const failure = await seedProject({
        account: null,
        project: "acme",
        workers: [h.api([dataCapability()])],
        projectDir: h.projectDir,
        env: "staging",
        redo: true,
        yes: true, // enough to SEED staging, deliberately not enough to DROP it
        json: true,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/destroys all of its data/i);
      expect((failure as PithyError).payload.action).toMatch(/--confirm-reset/);
    });

    test("a wrong or another env's reset phrase is refused", async () => {
      await h.writeWrangler(localWrangler);
      const attempt = (confirmReset: string) =>
        seedProject({
          account: null,
          project: "acme",
          workers: [h.api([dataCapability()])],
          projectDir: h.projectDir,
          env: "staging",
          redo: true,
          yes: true,
          json: true,
          confirmReset,
        }).catch((error: unknown) => error);

      expect(await attempt("yes")).toBeInstanceOf(PithyError);
      // The phrase names its environment, so one env's phrase cannot be pasted at another.
      expect(await attempt(resetConfirmPhrase("prod"))).toBeInstanceOf(PithyError);
    });

    test("dev needs no reset phrase — a local store is what reset is for", async () => {
      await h.writeWrangler(localWrangler);
      const report = await seedProject({
        account: null,
        project: "acme",
        workers: [h.api([dataCapability()])],
        projectDir: h.projectDir,
        env: "dev",
        redo: true,
      });
      expect(report.reset).toBeTruthy();
    });

    test("audits a successful reset, once it actually happened", async () => {
      await h.writeWrangler(localWrangler);
      const events: CliAuditEvent[] = [];
      await seedProject({
        account: null,
        project: "acme",
        workers: [h.api([dataCapability()])],
        projectDir: h.projectDir,
        env: "dev",
        redo: true,
        audit: async (event) => void events.push(event),
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "seed/schema_reset",
        outcome: "success",
        resourceType: "schema",
        resourceId: "dev",
      });
    });

    test("a reset that dies partway is audited as a failure, never a success, and still throws", async () => {
      await h.writeWrangler(localWrangler);
      // A migration whose `up` always throws: `resetMigrations` rolls back cleanly (nothing applied yet
      // against this fresh local D1), then blows up reapplying — reproducing a reset that dies partway.
      const brokenUp: Migration = {
        up: async () => {
          throw new Error("boom: reapply failed");
        },
        down: async (db) => {
          await db.schema.dropTable("things").execute();
        },
      };
      const broken = defineCapability({
        name: "app",
        requiredBindings: [],
        databases: {
          app: {
            binding: "DB",
            tables: { things: Things },
            migrations: { "0001_things": brokenUp },
            migrationOrder: 1000,
          },
        },
      });

      const events: CliAuditEvent[] = [];
      const failure = await seedProject({
        account: null,
        project: "acme",
        workers: [h.api([broken])],
        projectDir: h.projectDir,
        env: "dev",
        redo: true,
        audit: async (event) => void events.push(event),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "seed/schema_reset",
        outcome: "failure",
        resourceType: "schema",
        resourceId: "dev",
      });
    });

    test("a plain seed audits nothing — only a reset is destructive enough to record", async () => {
      await h.writeWrangler(localWrangler);
      const capabilities = [dataCapability()];
      await migrateProject({
        account: null,
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
        project: "acme",
      });

      const events: CliAuditEvent[] = [];
      await seedProject({
        account: null,
        project: "acme",
        workers: [h.api(capabilities)],
        projectDir: h.projectDir,
        env: "dev",
        audit: async (event) => void events.push(event),
      });
      expect(events).toEqual([]);
    });
  });
});
