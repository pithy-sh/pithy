// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  appCapability,
  createTable,
  createThings,
  migrateHarness,
  multiplayerCapability,
  pendingFrom,
} from "../test-utils/migrateHarness";
import { dropCapabilityTables, migrateProject, previewReset, readProjectLedger, resetProject } from "./run";

describe("migrateProject", () => {
  const h = migrateHarness();

  test("an empty registry reports the worker with no databases", async () => {
    const runs = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers: [h.api([])],
      env: "dev",
      project: "acme",
    });
    expect(runs).toEqual([{ worker: "api", databases: [] }]);
  });

  test("runs, persists, and rolls back against local D1", async () => {
    const workers = [h.api([appCapability()])];

    const first = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers,
      env: "dev",
      project: "acme",
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.worker).toBe("api");
    expect(first[0]?.databases[0]?.database).toBe("app");
    expect(first[0]?.databases[0]?.binding).toBe("DB");
    expect(first[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["1000_app_0001_things", "Up", "Success"],
    ]);

    // State persisted under the project root's .wrangler/state: a second run is a no-op.
    const second = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers,
      env: "dev",
      project: "acme",
    });
    expect(second[0]?.databases[0]?.results).toEqual([]);

    // --rollback steps the latest back.
    const rolledBack = await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers,
      env: "dev",
      project: "acme",
      rollback: true,
    });
    expect(rolledBack[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["1000_app_0001_things", "Down", "Success"],
    ]);
  });

  test("migrates the store wrangler serves when the stanza carries only a database_name", async () => {
    // `pithy add` writes `database_name: "<project>-<env>-<binding>"` with no `database_id`. Wrangler's
    // `d1DatabaseEntry` derives the Miniflare id from `preview_database_id ?? database_id` else the
    // binding — `database_name` is never read. Resolving the name here would put the tables in a file
    // `pithy dev` never opens, and every request would fail `D1_ERROR: no such table`.
    await writeFile(
      join(h.projectDir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({ d1_databases: [{ binding: "DB", database_name: "acme-dev-db" }] }),
    );

    await migrateProject({
      account: null,
      projectDir: h.projectDir,
      workers: [h.api([appCapability()])],
      env: "dev",
      project: "acme",
    });

    // Open the store exactly as wrangler binds it — id `DB` — and the migrated table is there.
    const mf = new Miniflare({
      modules: true,
      script: "export default {};",
      d1Databases: { DB: "DB" },
      d1Persist: join(h.projectDir, ".wrangler", "state", "v3", "d1"),
    });
    try {
      const count = await (await mf.getD1Database("DB"))
        .prepare("SELECT count(*) AS n FROM things")
        .first<{ n: number }>();
      expect(count?.n).toBe(0);
    } finally {
      await mf.dispose();
    }
  });

  test("a capability added out of migrationOrder migrates — the order typed never decides the order run", async () => {
    // The adopter's sequence: `pithy add email` (200), `pithy add auth` (300), `pithy add audit` (250).
    // Each add migrates the worker as it now stands, so audit's key lands between two applied ones.
    const capability = (name: string, order: number) =>
      defineCapability({
        name,
        requiredBindings: [],
        databases: {
          app: {
            binding: "DB",
            tables: {},
            migrations: { "0001_init": createTable(`${name}_rows`) },
            migrationOrder: order,
          },
        },
      });
    const email = capability("email", 200);
    const auth = capability("auth", 300);
    const audit = capability("audit", 250);
    const run = (capabilities: Capability[]) =>
      migrateProject({
        account: null,
        projectDir: h.projectDir,
        workers: [h.api(capabilities)],
        env: "dev",
        project: "acme",
      });

    await run([email]);
    await run([email, auth]);
    const third = await run([email, audit, auth]);

    expect(third[0]?.databases[0]?.results.map((r) => [r.migrationName, r.status])).toEqual([
      ["0250_audit_0001_init", "Success"],
    ]);
    // And the project is still migratable: the ledger is behind nothing.
    expect(
      await pendingFrom({
        account: null,
        projectDir: h.projectDir,
        workers: [h.api([email, audit, auth])],
        env: "dev",
      }),
    ).toBe(0);
  });

  describe("dropCapabilityTables", () => {
    test("reverses just the capability's migrations against local D1, and is idempotent", async () => {
      const workerDir = join(h.projectDir, "apps", "api");
      await migrateProject({
        account: null,
        projectDir: h.projectDir,
        workers: [h.api([appCapability()])],
        env: "dev",
        project: "acme",
      });

      const runs = await dropCapabilityTables({
        account: null,
        capability: appCapability(),
        workerDir,
        persistRoot: h.projectDir,
        env: "dev",
        project: "acme",
      });
      expect(runs[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
        ["1000_app_0001_things", "Down", "Success"],
      ]);

      // The table and its ledger row are gone — a second drop finds nothing to do.
      const again = await dropCapabilityTables({
        account: null,
        capability: appCapability(),
        workerDir,
        persistRoot: h.projectDir,
        env: "dev",
        project: "acme",
      });
      expect(again[0]?.results).toEqual([]);
    });
  });

  describe("resetProject", () => {
    test("rolls every migration back then forward, leaving the ledger consistent", async () => {
      const workers = [h.api([appCapability()])];
      await migrateProject({ account: null, projectDir: h.projectDir, workers, env: "dev", project: "acme" });
      expect(await pendingFrom({ account: null, projectDir: h.projectDir, workers, env: "dev" })).toBe(0);

      const runs = await resetProject({
        account: null,
        projectDir: h.projectDir,
        workers,
        env: "dev",
        project: "acme",
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.databases[0]?.database).toBe("app");
      expect(runs[0]?.databases[0]?.binding).toBe("DB");
      expect(runs[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
        ["1000_app_0001_things", "Down", "Success"],
        ["1000_app_0001_things", "Up", "Success"],
      ]);

      // The ledger is consistent afterwards: nothing pending, and a following plain migrate is a no-op.
      expect(await pendingFrom({ account: null, projectDir: h.projectDir, workers, env: "dev" })).toBe(0);
      const again = await migrateProject({
        account: null,
        projectDir: h.projectDir,
        workers,
        env: "dev",
        project: "acme",
      });
      expect(again[0]?.databases[0]?.results).toEqual([]);
    });

    test("destroys existing rows — a full reset, not a per-row merge", async () => {
      const workers = [h.api([appCapability()])];
      await migrateProject({ account: null, projectDir: h.projectDir, workers, env: "dev", project: "acme" });

      const d1Persist = join(h.projectDir, ".wrangler", "state", "v3", "d1");
      let mf = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: "DB" }, d1Persist });
      try {
        await (await mf.getD1Database("DB")).prepare("INSERT INTO things (id) VALUES (1)").run();
      } finally {
        await mf.dispose();
      }

      await resetProject({ account: null, projectDir: h.projectDir, workers, env: "dev", project: "acme" });

      mf = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: "DB" }, d1Persist });
      try {
        const count = await (await mf.getD1Database("DB"))
          .prepare("SELECT count(*) AS n FROM things")
          .first<{ n: number }>();
        expect(count?.n).toBe(0);
      } finally {
        await mf.dispose();
      }
    });

    test("an empty registry is a no-op", async () => {
      expect(
        await resetProject({
          account: null,
          projectDir: h.projectDir,
          workers: [h.api([])],
          env: "dev",
          project: "acme",
        }),
      ).toEqual([{ worker: "api", databases: [] }]);
    });
  });

  describe("previewReset", () => {
    test("counts the registry's migrations per database, with no backend access", async () => {
      const preview = await previewReset({
        account: null,
        projectDir: h.projectDir,
        workers: [h.api([appCapability()])],
        env: "dev",
      });
      expect(preview).toEqual([{ database: "app", binding: "DB", migrations: 1 }]);
    });

    test("previews a database two workers share once, with their merged count", async () => {
      const workers = [h.api([appCapability()]), await h.worker("collab", [multiplayerCapability("DB")])];
      expect(await previewReset({ account: null, projectDir: h.projectDir, workers, env: "dev" })).toEqual([
        { database: "app", binding: "DB", migrations: 2 },
      ]);
    });

    test("an empty registry previews nothing", async () => {
      expect(await previewReset({ account: null, projectDir: h.projectDir, workers: [h.api([])], env: "dev" })).toEqual(
        [],
      );
    });
  });

  describe("readProjectLedger", () => {
    test("counts unapplied migrations, and drops to zero once migrated", async () => {
      const workers = [h.api([appCapability()])];

      expect(await pendingFrom({ account: null, projectDir: h.projectDir, workers, env: "dev" })).toBe(1);

      await migrateProject({ account: null, projectDir: h.projectDir, workers, env: "dev", project: "acme" });
      expect(await pendingFrom({ account: null, projectDir: h.projectDir, workers, env: "dev" })).toBe(0);
    });

    test("an empty registry has nothing pending", async () => {
      expect(await pendingFrom({ account: null, projectDir: h.projectDir, workers: [h.api([])], env: "dev" })).toBe(0);
    });

    /**
     * The #371 gate. One database in scope will not answer; every sibling still reports.
     *
     * Asserted on the value rather than on a rendering, and in **both** directions the issue asks for:
     * the sibling's count survives (it is not blanked), and the answer is not the shape a clean read
     * has (it is not a zero). The second assertion is the one that matters — a `try`/`catch` alone
     * would satisfy the first while reporting `pending: 1` about a project with an unread database.
     */
    test("a database whose ledger will not read costs its own entry, never its siblings", async () => {
      await writeFile(
        join(h.projectDir, "apps", "api", "wrangler.jsonc"),
        JSON.stringify({
          d1_databases: [],
          env: {
            staging: {
              d1_databases: [
                { binding: "DB", database_id: "app-staging-id" },
                { binding: "COLLAB_DB", database_id: "collab-staging-id" },
              ],
            },
          },
        }),
      );
      await writeFile(join(h.projectDir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=acct-1\nCLOUDFLARE_API_TOKEN=tok-1\n");

      const miniflare = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { REMOTE: "app-staging-id" },
      });
      try {
        const reachable = (await miniflare.getD1Database("REMOTE")) as unknown as D1Database;
        // What a revoked token or a deleted database actually does to a read.
        const unreachable = {
          prepare(): never {
            throw new Error("D1_ERROR: Authentication error. token id 9f3c is not valid.");
          },
        } as unknown as D1Database;

        const ledger = await readProjectLedger({
          account: null,
          projectDir: h.projectDir,
          workers: [h.api([appCapability(), multiplayerCapability()])],
          env: "staging",
          remoteD1: ({ binding }) => (binding === "DB" ? reachable : unreachable),
        });

        expect(ledger).toEqual({
          state: "partial",
          counted: { pending: 1, undeclared: [] },
          unreadable: [{ database: "collab", binding: "COLLAB_DB" }],
        });
        // Not a clean read of anything. `partial` and `read` do not share a field, so no caller can
        // reach the count without having been told the sum is short.
        expect(ledger.state).not.toBe("read");
        expect("pending" in ledger).toBe(false);
        // And nothing the failure said travels — the token id above is throw-site context.
        expect(JSON.stringify(ledger)).not.toMatch(/9f3c|Authentication/);
      } finally {
        await miniflare.dispose();
      }
    });
  });

  describe("remote environments", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function writeStagingConfig(databaseId: string | null): Promise<void> {
      const d1 = databaseId ? [{ binding: "DB", database_id: databaseId }] : [];
      await writeFile(
        join(h.projectDir, "apps", "api", "wrangler.jsonc"),
        JSON.stringify({ d1_databases: [], env: { staging: { d1_databases: d1 } } }),
      );
    }

    /** The one repo-wide `.dev.vars` lives at the project root, not in a worker's directory. */
    async function writeCreds(): Promise<void> {
      await writeFile(join(h.projectDir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=acct-1\nCLOUDFLARE_API_TOKEN=tok-1\n");
    }

    test("resolves the env's database_id, applies, is idempotent, and rolls back over the REST driver", async () => {
      await writeStagingConfig("remote-staging-id");
      await writeCreds();

      // The REST-backed D1 is substituted with an in-memory Miniflare D1 — issue #24's client is
      // tested separately; here we assert the remote *orchestration* (id resolution, creds, ordering).
      const miniflare = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { REMOTE: "remote-staging-id" },
      });
      const remote = (await miniflare.getD1Database("REMOTE")) as unknown as D1Database;
      const resolved: { binding: string; databaseId: string }[] = [];
      const opts = {
        projectDir: h.projectDir,
        account: null,
        workers: [h.api([appCapability()])],
        env: "staging",
        project: "acme",
        remoteD1: (args: { binding: string; databaseId: string }): D1Database => {
          resolved.push(args);
          return remote;
        },
      };

      try {
        const first = await migrateProject(opts);
        expect(first[0]?.databases[0]?.database).toBe("app");
        expect(first[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
          ["1000_app_0001_things", "Up", "Success"],
        ]);
        // The remote id came from env.staging.d1_databases, not the (empty) top-level block.
        expect(resolved).toEqual([{ binding: "DB", databaseId: "remote-staging-id" }]);

        const second = await migrateProject(opts);
        expect(second[0]?.databases[0]?.results).toEqual([]);

        const rolledBack = await migrateProject({ ...opts, rollback: true });
        expect(rolledBack[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
          ["1000_app_0001_things", "Down", "Success"],
        ]);
      } finally {
        await miniflare.dispose();
      }
    });

    test("two workers pointing at one remote database_id resolve a single client", async () => {
      await writeStagingConfig("remote-staging-id");
      const collab = await h.worker("collab", [multiplayerCapability("DB")]);
      await writeFile(
        join(collab.dir, "wrangler.jsonc"),
        JSON.stringify({ env: { staging: { d1_databases: [{ binding: "DB", database_id: "remote-staging-id" }] } } }),
      );

      const miniflare = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { REMOTE: "remote-staging-id" },
      });
      try {
        const remote = (await miniflare.getD1Database("REMOTE")) as unknown as D1Database;
        const resolved: { binding: string; databaseId: string }[] = [];
        const runs = await migrateProject({
          account: null,
          projectDir: h.projectDir,
          workers: [h.api([appCapability()]), collab],
          env: "staging",
          project: "acme",
          remoteD1: (args): D1Database => {
            resolved.push(args);
            return remote;
          },
        });
        expect(resolved).toEqual([{ binding: "DB", databaseId: "remote-staging-id" }]);
        expect(runs[0]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["1000_app_0001_things"]);
        expect(runs[1]?.databases[0]?.results.map((r) => r.migrationName)).toEqual(["0500_multiplayer_0001_rooms"]);
      } finally {
        await miniflare.dispose();
      }
    });

    test("an empty registry is a no-op even remotely — no creds required", async () => {
      const runs = await migrateProject({
        account: null,
        projectDir: h.projectDir,
        workers: [h.api([])],
        env: "prod",
        project: "acme",
      });
      expect(runs).toEqual([{ worker: "api", databases: [] }]);
    });

    test("a worker with no env stanza fails with an actionable error naming it", async () => {
      await writeFile(join(h.projectDir, "apps", "api", "wrangler.jsonc"), JSON.stringify({ d1_databases: [] }));
      const failure = await migrateProject({
        account: null,
        projectDir: h.projectDir,
        workers: [h.api([appCapability()])],
        env: "staging",
        project: "acme",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/api: .*env\.staging/);
    });

    test("missing CF credentials fail with an actionable error", async () => {
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      await writeStagingConfig("remote-staging-id");

      const failure = await migrateProject({
        account: null,
        projectDir: h.projectDir,
        workers: [h.api([appCapability()])],
        env: "staging",
        project: "acme",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/credentials/i);
    });

    test("an injected remote D1 needs no ambient CF credentials", async () => {
      // Substituting the network client is the whole point of the `remoteD1` seam, so it must not
      // demand `CLOUDFLARE_*` — a regression guard for the CI-only failure where these were unset.
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      await writeStagingConfig("remote-staging-id");

      const miniflare = new Miniflare({
        modules: true,
        script: "export default {};",
        d1Databases: { REMOTE: "remote-staging-id" },
      });
      try {
        const remote = (await miniflare.getD1Database("REMOTE")) as unknown as D1Database;
        const runs = await migrateProject({
          account: null,
          projectDir: h.projectDir,
          workers: [h.api([appCapability()])],
          env: "staging",
          project: "acme",
          remoteD1: () => remote,
        });
        expect(runs[0]?.databases[0]?.results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
          ["1000_app_0001_things", "Up", "Success"],
        ]);
      } finally {
        await miniflare.dispose();
      }
    });

    test("a binding with no remote database_id fails with an actionable error", async () => {
      await writeStagingConfig(null);
      await writeCreds();

      const failure = await migrateProject({
        account: null,
        projectDir: h.projectDir,
        workers: [h.api([appCapability()])],
        env: "staging",
        project: "acme",
        remoteD1: (): D1Database => {
          throw new Error("must not resolve a D1 when the id is missing");
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toMatch(/database_id|DB/);
    });
  });

  test("refuses two databases in one worker that share a binding — their stores would collide", async () => {
    // `app` and `cache` both bound to DB with *different* tables: without a guard
    // both runs succeed against one physical store, silently sharing data and
    // kysely bookkeeping. The guard must reject this before running anything.
    const cap = defineCapability({
      name: "app",
      requiredBindings: [],
      databases: {
        app: { binding: "DB", tables: {}, migrations: { "0001_things": createThings }, migrationOrder: 100 },
        cache: {
          binding: "DB",
          tables: {},
          migrations: { "0001_widgets": createTable("widgets") },
          migrationOrder: 200,
        },
      },
    });
    await expect(
      migrateProject({ account: null, projectDir: h.projectDir, workers: [h.api([cap])], env: "dev", project: "acme" }),
    ).rejects.toThrow(/share|bound to/i);
  });
});
