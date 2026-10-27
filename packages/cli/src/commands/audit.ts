// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { AuditChainExport, ChainBreak, verifyChainExport } from "@pithy-sh/core/src/audit/chain";
import { InputRequiredError, PreconditionFailedError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { defineCommand } from "citty";
import { z } from "zod";
import { createProjectCliAudit } from "../audit/cliAudit";
import { findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { cloudflareClients } from "../cloudflare/clients";
import { commandCredentials } from "../cloudflare/commandCredentials";
import { withContract } from "../contract/commandContract";
import { loadProject, loadProjectEnvironments, projectCloudflareAccount, requireProjectName } from "../project/config";
import { requireManagedEnvironment } from "../project/environment";
import { provisionRemedy, withProvisionFix } from "../provision/provisionFix";
import { EXIT } from "../terminal/exitClass";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";
import { stripControls } from "../terminal/style";

/**
 * `pithy audit` (#822): the audit trail's hash chain, from the outside.
 *
 * `verify <file>` checks an export offline — every link, every commitment it carries values for, every checkpoint
 * — so an auditor trusts neither the Worker nor us. It reads a file and nothing else: no project, no credentials,
 * no network. `lock --env` puts the object-lock rule on the checkpoint bucket, which is what makes a checkpoint
 * evidence rather than a file. `docs/commands/audit.md`.
 */

/** The binding the checkpoint bucket is declared as by `@pithy-sh/audit`. `auditCommand.test.ts` holds the two equal. */
export const AUDIT_CHECKPOINT_BINDING = "AUDIT_CHECKPOINTS";

/** The prefix every checkpoint object lives under, and the one the lock rule covers. Held equal the same way. */
export const AUDIT_CHECKPOINT_PREFIX = "checkpoints/";

/** The lock rule's id on the bucket. */
export const AUDIT_CHECKPOINT_LOCK_RULE = "pithy-audit-checkpoints";

/** The checkpoint bucket's name in one environment: the name `pithy provision` gives the binding. */
export function checkpointBucketName(project: string, env: string): string {
  return environmentScope(project, env).resource(AUDIT_CHECKPOINT_BINDING, "r2", {});
}

/** `pithy audit verify --json`. */
const AuditVerifyPayload = z
  .object({
    command: z.literal("audit verify").describe('`"audit verify"`.'),
    file: z.string().describe("The export file read, as given."),
    tenant: z
      .string()
      .nullable()
      .describe("The tenant whose chain the export holds, or null for the untenanted chain."),
    intact: z.boolean().describe("Whether the export's chain is whole against its checkpoints."),
    checked: z.number().int().nonnegative().describe("How many events were checked before the first break."),
    checkpoints: z.number().int().nonnegative().describe("How many of the tenant's checkpoints the export carried."),
    values: z.boolean().describe("Whether the export carried personal values, so their commitments were checked too."),
    break: ChainBreak.nullable().describe("The first break, or null."),
  })
  .describe("What `pithy audit verify` found in one export. Exit code 1 when the chain is broken.");

/** Read and parse an export file, refusing anything that is not one with a sentence rather than a stack. */
export async function readChainExport(file: string): Promise<AuditChainExport> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ValidationError({
      message: `Cannot read ${file}.`,
      action: "Pass the path of a file saved from GET {audit}/control-plane/export.",
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ValidationError({
      message: `${file} is not JSON.`,
      action: "Pass the body of GET {audit}/control-plane/export, saved as it came.",
    });
  }
  const parsed = AuditChainExport.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError({
      message: `${file} is not an audit export.`,
      action: "Pass the body of GET {audit}/control-plane/export, saved as it came.",
      detail: parsed.error.message,
    });
  }
  return parsed.data;
}

/**
 * The human lines for one verification. The event id and the detail come out of the file being checked, which is the
 * file nobody trusts yet, so every control character is stripped: an id carrying an escape sequence could otherwise
 * erase the "Broken" lines and print "Intact" in their place, leaving only the exit code to tell the truth.
 */
export function verifyLines(result: {
  intact: boolean;
  checked: number;
  checkpoints: number;
  break: ChainBreak | null;
}): string[] {
  const counted = `${result.checked} ${result.checked === 1 ? "event" : "events"}, ${result.checkpoints} ${result.checkpoints === 1 ? "checkpoint" : "checkpoints"}.`;
  if (result.intact) return [`Intact. ${counted}`];
  const found = result.break as ChainBreak;
  return [
    `Broken at position ${found.position}${found.eventId ? `, event ${stripControls(found.eventId)}` : ""}: ${stripControls(found.reason)}.`,
    stripControls(found.detail),
    `Checked before the break: ${counted}`,
  ];
}

const verify = withContract(
  defineCommand({
    meta: { name: "verify", description: "Verify an audit export offline, against its checkpoints" },
    args: {
      file: { type: "positional", required: true, description: "The export file to verify" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const document = await readChainExport(args.file);
        const result = await verifyChainExport(document);
        // A broken chain is an answer, not an error: the report is the output, and the exit code says it.
        if (!result.intact) process.exitCode = EXIT.failed;
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({
              command: "audit verify",
              file: args.file,
              tenant: document.tenant,
              intact: result.intact,
              checked: result.checked,
              checkpoints: result.checkpoints,
              values: document.detail,
              break: result.break,
            })}\n`,
          );
          return;
        }
        for (const line of verifyLines(result)) process.stdout.write(`${line}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: AuditVerifyPayload,
    mutates: false,
    idempotent: true,
    needsNetwork: false,
  },
);

/** `pithy audit lock --json`. */
const AuditLockPayload = z
  .object({
    command: z.literal("audit lock").describe('`"audit lock"`.'),
    env: z.string().describe("The environment whose checkpoint bucket was locked."),
    bucketName: z.string().describe("The checkpoint bucket."),
    lock: z
      .enum(["added", "already"])
      .describe("`added` — this run added the rule. `already` — an indefinite rule already covered the checkpoints."),
  })
  .describe("What `pithy audit lock` did to one environment's checkpoint bucket.");

const lock = withContract(
  defineCommand({
    meta: { name: "lock", description: "Put an indefinite object lock on the audit checkpoint bucket" },
    args: {
      env: { type: "string", description: "The environment whose checkpoint bucket to lock. Required" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        if (args.env === undefined) {
          throw new InputRequiredError({
            message: "Name the environment to lock.",
            action: "Pass --env, e.g. --env prod.",
            flag: "--env",
          });
        }
        const projectDir = process.cwd();
        const project = await loadProject(projectDir);
        const env = requireManagedEnvironment(args.env, loadProjectEnvironments(project));
        const projectName = requireProjectName(project);
        const { account, accountId, apiToken } = commandCredentials(await projectCloudflareAccount(projectDir));
        const clients = await cloudflareClients({ accountId, apiToken });
        const bucket = checkpointBucketName(projectName, env);
        const r2 = clients.r2Provisioner();
        const found = await findOnConfirmedAccount({
          ...account,
          what: `the ${bucket} bucket`,
          find: () => r2.findBucketByName(bucket),
        });
        if (!found) {
          // The shared remedy: a fix an agent can run, and none for an environment the project calls production.
          const productionEnvironments = project.seed?.productionEnvironments ?? [];
          throw withProvisionFix(
            new PreconditionFailedError({
              message: `The checkpoint bucket ${bucket} does not exist.`,
              action: provisionRemedy(env, productionEnvironments).say(
                (command) => `Run ${command} to create it, then run this again.`,
              ),
            }),
            env,
            productionEnvironments,
          );
        }
        const outcome = await r2.lockPrefixIndefinitely(bucket, AUDIT_CHECKPOINT_PREFIX, AUDIT_CHECKPOINT_LOCK_RULE);
        if (outcome === "locked") {
          const audit = await createProjectCliAudit({ projectDir, accountId, apiToken, env, actedOn: env });
          await audit({
            environment: env,
            action: "audit/checkpoints_locked",
            outcome: "success",
            severity: "warning",
            resourceType: "cf_r2_bucket",
            resourceId: bucket,
            metadata: { prefix: AUDIT_CHECKPOINT_PREFIX, rule: AUDIT_CHECKPOINT_LOCK_RULE },
          });
        }
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({ command: "audit lock", env, bucketName: bucket, lock: outcome === "locked" ? "added" : "already" })}\n`,
          );
          return;
        }
        process.stdout.write(
          outcome === "locked"
            ? `Locked ${bucket}. Checkpoints there can no longer be replaced or deleted.\n`
            : `${bucket} is already locked.\n`,
        );
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: AuditLockPayload,
    // Adds a lock rule, once: a re-run finds it in force and changes nothing.
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

export default defineCommand({
  meta: { name: "audit", description: "Verify the audit trail's hash chain, and lock its checkpoints" },
  subCommands: { verify, lock },
});
