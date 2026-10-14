// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolve } from "node:path";
import { defineCommand } from "citty";
import { z } from "zod";
import { withContract } from "../contract/commandContract";
import { WorkerContractReport, writeContracts } from "../openapi/workerContract";
import { loadProject, requireProjectName } from "../project/config";
import { requireEnvironment } from "../project/environment";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";

/** The environment a contract is composed for when none is named: the table a shipped client calls. */
export const DEFAULT_CONTRACT_ENVIRONMENT = "prod";

/** `pithy contract --json`. `docs/commands/contract.md`. */
const ContractPayload = z
  .object({
    command: z.literal("contract").describe('`"contract"`.'),
    environment: z.string().describe("The environment every Worker was composed for."),
    workers: z.array(WorkerContractReport).describe("One entry per Worker, in `apps/` order."),
  })
  .describe("What `pithy contract` wrote: one OpenAPI document per Worker.");

/** The human lines for one Worker's report. */
export function renderReport(report: WorkerContractReport): string[] {
  const lines = [
    `${report.worker}: ${report.operations} operations. ${report.changed ? "Wrote" : "Unchanged:"} ${report.path}.`,
  ];
  if (report.undescribed.length > 0) {
    lines.push(
      dim(`  ${report.undescribed.length} without describeRoute, written from their validators and marked:`),
      ...report.undescribed.map((route) => dim(`    ${route.method} ${route.path}`)),
    );
  }
  return lines;
}

export default withContract(
  defineCommand({
    meta: { name: "contract", description: "Write each worker's OpenAPI document" },
    args: {
      worker: { type: "string", description: "Only this worker (default: every worker under apps/)" },
      out: {
        type: "string",
        description: "Write into this directory, as <dir>/<worker>/openapi.json (default: apps/<worker>/openapi.json)",
      },
      env: {
        type: "string",
        default: DEFAULT_CONTRACT_ENVIRONMENT,
        description: "The environment to compose each worker for",
      },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const environment = requireEnvironment(args.env);
        const projectDir = process.cwd();
        const project = requireProjectName(await loadProject(projectDir));
        const workers = await writeContracts({
          projectDir,
          project,
          environment,
          ...(args.worker === undefined ? {} : { worker: args.worker }),
          ...(args.out === undefined ? {} : { outDir: resolve(projectDir, args.out) }),
        });
        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "contract", environment, workers })}\n`);
          return;
        }
        for (const report of workers) {
          for (const line of renderReport(report)) process.stdout.write(`${line}\n`);
        }
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: ContractPayload,
    // Writes files, and writes the same bytes on a re-run: an unchanged document is left alone.
    mutates: true,
    idempotent: true,
    needsNetwork: false,
  },
);
