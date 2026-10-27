// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolve } from "node:path";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { defineCommand } from "citty";
import { z } from "zod";
import { backupRestoreAudit } from "../backup/audit";
import { DatabaseRestore, runRestore } from "../backup/restore";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareCredentials } from "../cloudflare/config";
import { withContract } from "../contract/commandContract";
import { requireMigrationGroup } from "../migrations/groups";
import { loadProject, projectCloudflareAccount, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment } from "../project/environment";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";
import { startStep } from "../terminal/progress";
import { cliVersion } from "./backup";

/** A recovery database: its D1 name, and what this run opens it by. */
export interface RecoveryDatabase {
  /** The D1 `database_name`, `<project>-<env>-<name>`. */
  name: string;
  /** The remote `database_id`, or the local store's id for `dev`. */
  id: string;
  /** Whether this run created it. */
  created: boolean;
}

/**
 * The database `--database <name>` restores into: `<project>-<env>-<name>`, composed through the naming
 * facade like every D1 the kit provisions. Locally it is a Miniflare store of that name. Remotely it is
 * found by name, and created when there is none, through `@pithy-sh/cloudflare` — `d1:write`, which the
 * `ci-system` profile already carries for `pithy migrate`. Either way the restore still refuses it unless it
 * is empty.
 */
export async function recoveryDatabase(
  project: string,
  env: string,
  name: string,
  account: CloudflareAccountSelection | null,
): Promise<RecoveryDatabase> {
  const full = resourceNames(project).env(env).d1(name);
  if (env === LOCAL_ENVIRONMENT) return { name: full, id: full, created: false };
  const provisioner = (await cloudflareClients(cloudflareCredentials({ account }))).d1Provisioner();
  const found = await provisioner.findDatabaseByName(full);
  if (found !== null) return { name: full, id: found.uuid, created: false };
  startStep(`Creating ${full}`);
  const made = await provisioner.createDatabase(full);
  return { name: full, id: made.uuid, created: true };
}

/** What {@link formatRestoreReport} renders. */
export interface RestoreRender {
  /** The project restored. */
  project: string;
  /** The environment restored into. */
  env: string;
  /** The recovery database, when `--database` named one. */
  recovery?: RecoveryDatabase;
  /** Machine-readable output. */
  json: boolean;
}

/** One line per database, one per index brought back, and where to point a binding at a recovery database. */
export function formatRestoreReport(databases: readonly DatabaseRestore[], options: RestoreRender): string {
  if (options.json) {
    return `${formatJsonLine({
      command: "restore",
      project: options.project,
      env: options.env,
      recovery: options.recovery,
      databases,
    })}\n`;
  }
  const width = Math.max(0, ...databases.map((database) => database.binding.length));
  const lines: string[] = [];
  for (const database of databases) {
    lines.push(
      `${database.binding.padEnd(width)}  ${database.migrations} migrations, ${database.tables} tables, ${database.rows} rows restored.`,
    );
    for (const index of database.rebuilt) {
      lines.push(
        index.how === "provisioned"
          ? `${database.binding}: ${index.name} rebuilt and backfilled.`
          : `${database.binding}: ${index.name} recreated empty. Refill it yourself.`,
      );
    }
  }
  if (options.recovery) {
    const [first] = databases;
    lines.push(
      `Restored into ${options.recovery.name} (${options.recovery.id}). Point ${first?.binding ?? "the binding"}'s database_id at it in wrangler.jsonc to use it.`,
    );
  }
  return `${lines.join("\n")}\n${formatDone()}\n`;
}

/** `pithy restore --json`. */
const RestorePayload = z
  .object({
    command: z.literal("restore").describe('`"restore"`.'),
    project: z.string().describe("The project restored."),
    env: z.string().describe("The environment restored into."),
    recovery: z
      .object({
        name: z.string().describe("The D1 `database_name`, `<project>-<env>-<name>`."),
        id: z.string().describe("Its `database_id`, or the local store's id for `dev`."),
        created: z.boolean().describe("Whether this run created it."),
      })
      .optional()
      .describe("The recovery database `--database` restored into. Absent without the flag."),
    databases: z.array(DatabaseRestore).describe("One entry per database restored, in fan-out order."),
  })
  .describe("What `pithy restore` restored.");

export default withContract(
  defineCommand({
    meta: { name: "restore", description: "Restore a backup into an empty D1" },
    args: {
      dir: {
        type: "positional",
        required: true,
        description: "The directory a backup wrote, or one database's folder inside it",
      },
      env: ENV_ARG,
      worker: { type: "string", description: "Restore only the databases this Worker binds" },
      binding: { type: "string", description: "Restore only the database behind this D1 binding" },
      database: {
        type: "string",
        description:
          "Restore into a fresh recovery database, <project>-<env>-<name>, created when absent. Needs one database in scope",
      },
      group: { type: "string", description: "The migration group the restore's migrate runs under" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const env = requireEnvironment(args.env);
        const projectDir = process.cwd();
        const config = await loadProject(projectDir);
        const project = requireProjectName(config);
        const account = await projectCloudflareAccount(projectDir);
        const group = requireMigrationGroup(args.group);
        const audit = await backupRestoreAudit({
          projectDir,
          env,
          account,
          ...(args.worker !== undefined ? { worker: args.worker } : {}),
        });
        let recovery: RecoveryDatabase | undefined;
        const name = args.database;
        const databases = await runRestore({
          projectDir,
          project,
          account,
          env,
          input: resolve(projectDir, args.dir),
          kitVersion: cliVersion(),
          ...(args.worker !== undefined ? { worker: args.worker } : {}),
          ...(args.binding !== undefined ? { binding: args.binding } : {}),
          ...(group !== undefined ? { group } : {}),
          audit,
          ...(name !== undefined
            ? {
                recovery: async () => {
                  const found = await recoveryDatabase(project, env, name, account);
                  recovery = found;
                  // Recorded at once, whatever the restore does next: the database exists from here. The
                  // audit row lands in the live app database, which a recovery restore never writes.
                  if (found.created) {
                    await audit({
                      action: "restore/recovery_database_created",
                      outcome: "success",
                      severity: "warning",
                      resourceType: "d1_database",
                      resourceId: found.name,
                      metadata: { id: found.id },
                    });
                  }
                  return found.id;
                },
              }
            : {}),
        });
        process.stdout.write(
          formatRestoreReport(databases, {
            project,
            env,
            json: args.json,
            ...(recovery !== undefined ? { recovery } : {}),
          }),
        );
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: RestorePayload,
    mutates: true,
    idempotent: false,
    needsNetwork: true,
  },
);
