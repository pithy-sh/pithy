// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { uniqueName } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { readMigrationGroups } from "@pithy-sh/core/src/migrations/groups";
import { email } from "@pithy-sh/email/src/capability";
import { describe, expect, test } from "vitest";
import { cloudflareEnv } from "../cloudflare/config";
import { createTable } from "../test-utils/migrateHarness";
import { rollbackConfirmPhrase } from "./confirm";
import { migrateProject, type WorkerMigrationRun } from "./run";

/**
 * **Migration groups, LIVE against real D1 over the REST API, in both directions (#694).**
 *
 * The unit suites prove the mechanism against Miniflare, which is the same Kysely over a different
 * driver. What only a real account can prove is the part this feature actually adds to a deploy: that a
 * group recorded over the REST API, across **two** databases, holding both an adopter's own migration and
 * a composed capability's, comes back as one group — and that `--rollback --group` reverses exactly it,
 * remotely, where every statement is its own round trip and there is no transaction anywhere.
 *
 * It creates two throwaway D1 databases named through `uniqueName`, so they land in the reserved
 * `pithy-int-` namespace and the reaper can reclaim them if this run is killed before its `finally`. Both
 * are deleted unconditionally — a failed assertion still tears them down.
 *
 * Gated on CF credentials; with none present the whole suite skips. `bun run test:integration`.
 */
const vars = cloudflareEnv({ account: null });
const hasCreds = Boolean(vars.CLOUDFLARE_ACCOUNT_ID && vars.CLOUDFLARE_API_TOKEN);

/** The release this run promotes and then reverses — the caller-held value a dashboard would pass. */
const RELEASE = "2026.10.3-integration";

/** The adopter's own capability: one migration, on the database the kit's capabilities also use. */
function adopterApp(): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    databases: {
      app: { binding: "DB", tables: {}, migrations: { "0001_things": createTable("things") }, migrationOrder: 1000 },
    },
  });
}

/** The composed capability: `@pithy-sh/email`, which migrates `DB` and `EMAIL_SUPPRESSIONS` both. */
function mail(): Capability {
  return email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" });
}

/** What migrations moved, flattened across the run — direction included. */
function moved(runs: WorkerMigrationRun[]): [string, string][] {
  return runs.flatMap((run) =>
    run.databases.flatMap((database) => database.results.map((result) => [result.migrationName, result.direction])),
  ) as [string, string][];
}

/** The applied migration names in a remote database's ledger. */
async function ledgerOf(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("select name from pithy_migrations order by name").all<{ name: string }>();
  return (results ?? []).map((row) => row.name);
}

/** Whether a table exists in a remote database — how the group table's exemption is checked. */
async function hasTable(db: D1Database, name: string): Promise<boolean> {
  const row = await db
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .bind(name)
    .first<{ name: string }>();
  return row !== null;
}

/** What a rejected promise threw, as a `PithyError` — or a failed assertion when it resolved. */
async function refusal(promise: Promise<unknown>): Promise<PithyError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(PithyError);
  return outcome as PithyError;
}

describe.skipIf(!hasCreds)("migration groups — LIVE against real D1 over REST", () => {
  test("a group spanning two databases is recorded, refuses a bare rollback, and reverses by name", async () => {
    const cf = new CloudflareClients({
      accountId: vars.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: vars.CLOUDFLARE_API_TOKEN ?? "",
    });
    const provisioner = cf.d1Provisioner();
    const app = await provisioner.createDatabase(uniqueName("groups-app"));
    const suppressions = await provisioner.createDatabase(uniqueName("groups-supp"));
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-groups-live-"));
    try {
      await mkdir(join(projectDir, "apps", "api"), { recursive: true });
      // One environment's stanza only, so neither database is bound by another environment: what a
      // shared database does to a group rollback is unit-tested, and is not what this run is about.
      await writeFile(
        join(projectDir, "apps", "api", "wrangler.jsonc"),
        `${JSON.stringify(
          {
            env: {
              staging: {
                d1_databases: [
                  { binding: "DB", database_id: app.uuid },
                  { binding: "EMAIL_SUPPRESSIONS", database_id: suppressions.uuid },
                ],
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const options = {
        account: null,
        projectDir,
        env: "staging",
        project: "acme",
        workers: [{ name: "api", dir: join(projectDir, "apps", "api"), capabilities: [mail(), adopterApp()] }],
      };
      const remoteApp = cf.d1(app.uuid) as unknown as D1Database;
      const remoteSuppressions = cf.d1(suppressions.uuid) as unknown as D1Database;

      // Forward: one run, two databases, the adopter's migration and the capability's in one group.
      const forward = await migrateProject({ ...options, group: RELEASE });
      expect(moved(forward)).toEqual([
        ["0200_email_0001_init", "Up"],
        ["1000_app_0001_things", "Up"],
        ["0100_email_0001_suppressions", "Up"],
      ]);
      expect((await readMigrationGroups(remoteApp)).map((entry) => [entry.group, entry.migrations])).toEqual([
        [RELEASE, ["0200_email_0001_init", "1000_app_0001_things"]],
      ]);
      // The same value in the other database: one run is one group, however many databases it spans.
      expect((await readMigrationGroups(remoteSuppressions)).map((entry) => [entry.group, entry.migrations])).toEqual([
        [RELEASE, ["0100_email_0001_suppressions"]],
      ]);

      // Back, with no group: nothing is reversed, and the refusal names the group and the command.
      const refused = await refusal(
        migrateProject({ ...options, rollback: true, confirmRollback: rollbackConfirmPhrase("staging") }),
      );
      expect(refused.payload.message).toContain(`The newest group is ${RELEASE}`);
      expect(refused.payload.action).toBe(`Reverse it with pithy migrate --rollback --group ${RELEASE}.`);
      expect(await ledgerOf(remoteApp)).toEqual(["0200_email_0001_init", "1000_app_0001_things"]);
      expect(await ledgerOf(remoteSuppressions)).toEqual(["0100_email_0001_suppressions"]);

      // Back, by name: every migration in the group, per database, in reverse chain order.
      const back = await migrateProject({
        ...options,
        rollback: true,
        group: RELEASE,
        confirmRollback: rollbackConfirmPhrase("staging"),
      });
      expect(moved(back)).toEqual([
        ["1000_app_0001_things", "Down"],
        ["0200_email_0001_init", "Down"],
        ["0100_email_0001_suppressions", "Down"],
      ]);
      expect(await ledgerOf(remoteApp)).toEqual([]);
      expect(await ledgerOf(remoteSuppressions)).toEqual([]);
      // The reversed group's rows are gone; the table beside the ledger stands, like the owner stamp.
      expect(await readMigrationGroups(remoteApp)).toEqual([]);
      expect(await hasTable(remoteApp, "pithy_migrations_groups")).toBe(true);
      expect(await hasTable(remoteSuppressions, "pithy_migrations_groups")).toBe(true);
      expect(await hasTable(remoteApp, "pithy_migrations_owner")).toBe(true);

      // And the release can be promoted again under the same stamp — the retry case, live.
      const again = await migrateProject({ ...options, group: RELEASE });
      expect(moved(again)).toHaveLength(3);
      expect((await readMigrationGroups(remoteApp)).map((entry) => entry.group)).toEqual([RELEASE]);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      await provisioner.deleteDatabase(app.uuid);
      await provisioner.deleteDatabase(suppressions.uuid);
    }
  });
});
