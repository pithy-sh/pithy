// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { z } from "zod";
import { backupRestoreAudit } from "../backup/audit";
import { DatabaseBackup, defaultBackupDir, runBackup } from "../backup/backup";
import { withContract } from "../contract/commandContract";
import { loadProject, projectCloudflareAccount, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment } from "../project/environment";
import { EXIT } from "../terminal/exitClass";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/** The CLI's own version — what a backup records as the kit that took it. */
export function cliVersion(): string {
  return (
    JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;
}

/** What {@link formatBackupReport} renders. */
export interface BackupRender {
  /** The project backed up. */
  project: string;
  /** The environment backed up. */
  env: string;
  /** The directory written to, as the operator passed it or as it defaulted. */
  output: string;
  /** Machine-readable output. */
  json: boolean;
}

/**
 * One line per database, then where the files are — or, for a row over D1's statement limit, the file and
 * line of each and the line that says D1 cannot take this backup back. No `Done.` then: the run exits 1.
 */
export function formatBackupReport(databases: readonly DatabaseBackup[], options: BackupRender): string {
  const restorable = databases.every((database) => database.restorable);
  if (options.json) {
    return `${formatJsonLine({
      command: "backup",
      project: options.project,
      env: options.env,
      output: options.output,
      restorable,
      databases,
    })}\n`;
  }
  if (databases.length === 0) return `No D1 databases in ${options.env}.\n${formatDone()}\n`;
  const width = Math.max(...databases.map((database) => database.binding.length));
  const lines = databases.map((database) => {
    const counts = `${database.tables} ${database.tables === 1 ? "table" : "tables"}, ${database.rows} ${database.rows === 1 ? "row" : "rows"}.`;
    const left =
      database.virtualTables.length > 0 ? ` Left out, rebuilt on restore: ${database.virtualTables.join(", ")}.` : "";
    return `${database.binding.padEnd(width)}  ${counts}${left}`;
  });
  for (const database of databases) {
    for (const row of database.oversized) {
      lines.push(
        `${database.binding}: ${database.folder}/${row.file} line ${row.line} is ${row.bytes} bytes, over D1's 100,000-byte statement limit.`,
      );
    }
  }
  lines.push(`Written to ${options.output}.`);
  if (!restorable) {
    lines.push("Kept, and not restorable to D1. sqlite3 imports the files; D1 Time Travel recovers in place.");
    return `${lines.join("\n")}\n`;
  }
  return `${lines.join("\n")}\n${formatDone()}\n`;
}

/** `pithy backup --json`. */
const BackupPayload = z
  .object({
    command: z.literal("backup").describe('`"backup"`.'),
    project: z.string().describe("The project backed up."),
    env: z.string().describe("The environment backed up."),
    output: z.string().describe("The directory the backup was written to."),
    restorable: z.boolean().describe("Whether D1 can take every database back. False exits 1, with the files kept."),
    databases: z.array(DatabaseBackup).describe("One entry per database, in fan-out order."),
  })
  .describe("What `pithy backup` wrote.");

export default withContract(
  defineCommand({
    meta: { name: "backup", description: "Back up every D1 an environment's Workers bind" },
    args: {
      env: ENV_ARG,
      worker: { type: "string", description: "Back up only the databases this Worker binds" },
      binding: { type: "string", description: "Back up only the database behind this D1 binding" },
      output: {
        type: "string",
        description: "The directory to write. Defaults to backups/<env>-<timestamp>; refused when it holds anything",
      },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const env = requireEnvironment(args.env);
        const projectDir = process.cwd();
        const config = await loadProject(projectDir);
        const project = requireProjectName(config);
        const account = await projectCloudflareAccount(projectDir);
        const output = args.output ?? defaultBackupDir(env, new Date());
        const databases = await runBackup({
          projectDir,
          project,
          account,
          env,
          output: resolve(projectDir, output),
          kitVersion: cliVersion(),
          ...(args.worker !== undefined ? { worker: args.worker } : {}),
          ...(args.binding !== undefined ? { binding: args.binding } : {}),
          audit: await backupRestoreAudit({
            projectDir,
            env,
            account,
            ...(args.worker !== undefined ? { worker: args.worker } : {}),
          }),
        });
        process.stdout.write(formatBackupReport(databases, { project, env, output, json: args.json }));
        // Kept and reported, and still a failure: a CI job that backs up has to notice it cannot restore.
        if (!databases.every((database) => database.restorable)) process.exitCode = EXIT.failed;
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: BackupPayload,
    mutates: false,
    idempotent: false,
    needsNetwork: true,
  },
);
