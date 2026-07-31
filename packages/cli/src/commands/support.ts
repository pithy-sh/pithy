// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { parse } from "comment-json";
import { createCliAudit } from "../audit/cliAudit";
import { resolveR2Credentials } from "../capabilities/r2Bucket";
import {
  CloudflareSupportDeprovisioner,
  CloudflareSupportProvisioner,
  loadSupport,
  type SupportEnvResources,
} from "../capabilities/supportProvisioner";
import { projectCapabilities, type ResolvedWorker, resolveSingleWorker, resolveWorkers } from "../project/workerScope";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy support provision` / `deprovision` — the command the support manifest, README, and wrangler
 * template have always pointed at. It creates the `SUPPORT_BUCKET` R2 bucket, deploys the prebuilt
 * classification worker for every managed environment, and creates the Email Routing rule that delivers
 * the support address to the app worker.
 *
 * **The routing flags are all-or-nothing, and deliberately explicit.** Enabling Email Routing on a zone
 * points its MX at Cloudflare, so a rule created on the wrong zone moves an adopter's real inbound mail
 * off their existing provider. That is not a mistake a provisioning command gets to make on somebody's
 * behalf, so the zone, the address, and the target worker are each named or the rule is not created —
 * everything else provisions, and the rule is added when the operator has decided.
 *
 * No secret is written. The classification worker reads a message and writes a label over the `AI`
 * binding, so it carries no credential; the R2 key pair support presigns attachments with belongs to
 * `@pithy-sh/storage` and is written by `pithy storage provision`.
 */

/**
 * The audit emitter for a support command. Provisioning spans every managed environment at once, so there
 * is no single target env to key the audit database on — `"dev"` is the fallback (the convention `pithy
 * email` and `pithy media` already use for env-spanning commands). A no-op when creds or the audit
 * capability aren't there.
 */
async function buildAudit(projectDir: string, accountId: string, apiToken: string, worker?: string) {
  const capabilities = await resolveWorkers({ projectDir })
    .then(projectCapabilities)
    .catch(() => []);
  return createCliAudit({
    projectDir,
    env: "dev",
    capabilities,
    ...(worker !== undefined ? { worker } : {}),
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/** Load the support capability's resolved config from `pithy.config.ts`. */
async function loadSupportConfig(projectDir: string) {
  const { isSupportCapability } = await loadSupport();
  // Capabilities live in each Worker's `apps/<name>/pithy.config.ts`; provisioning is one project-wide
  // decision, so the first Worker composing this capability provides it.
  const capability = (await resolveWorkers({ projectDir }).then(projectCapabilities)).find(isSupportCapability);
  if (!capability) {
    throw new ValidationError({
      message: "The support capability is not configured.",
      action: "Add `support({ ... })` to a worker's pithy.config.ts (run `pithy add support`).",
    });
  }
  return capability.supportConfig;
}

/** The CF credentials support provisioning needs, from `.dev.vars` then `process.env`. */
function loadCloudflareCreds(projectDir: string): {
  accountId: string;
  apiToken: string;
  r2Raw: string | undefined;
} {
  const vars = loadCloudflareEnv(projectDir);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .dev.vars.",
    });
  }
  // No Secrets Store id, unlike email and media: the classification worker binds `DB` and `AI` and holds
  // no credential to decrypt.
  return { accountId, apiToken, r2Raw: vars.R2_CREDENTIALS };
}

/** A wrangler env stanza — only the field the support worker deploy reads from a Worker's config. */
interface WranglerStanza {
  d1_databases?: { binding: string; database_id?: string }[];
  env?: Record<string, WranglerStanza | undefined>;
}

/**
 * Resolve the per-environment app database the classification worker binds, from the **app Worker's**
 * `wrangler.jsonc`. A missing stanza or id throws an actionable error rather than deploying a worker that
 * would write its classifications into nothing.
 *
 * Which Worker is the app Worker? Every Worker owns its own `wrangler.jsonc`, so a project with several
 * names one with `--worker`; one Worker needs no ceremony. Workers sharing a database share the `DB`
 * binding name, so any Worker carrying the support tables answers the same id.
 */
function buildResolveEnv(worker: ResolvedWorker): (env: ManagedEnvironment) => Promise<SupportEnvResources> {
  return async (env) => {
    const path = join(worker.dir, "wrangler.jsonc");
    const config = parse(await readFile(path, "utf8")) as unknown as WranglerStanza;
    const stanza = config.env?.[env];
    if (!stanza) {
      throw new ValidationError({
        message: `${worker.name}'s wrangler.jsonc has no env.${env} stanza.`,
        action: `Add the ${env} environment to ${path} with its DB binding.`,
      });
    }
    const appDatabaseId = stanza.d1_databases?.find((db) => db.binding === "DB")?.database_id;
    if (!appDatabaseId) {
      throw new ValidationError({
        message: `${worker.name}'s wrangler.jsonc env.${env} has no DB database_id.`,
        action: `Provision the ${env} app database and set its id on the DB binding.`,
      });
    }
    return { appDatabaseId };
  };
}

/**
 * The three routing flags, together or not at all.
 *
 * A partial set is rejected rather than quietly treated as "no routing": an operator who passed two of
 * three asked for a rule, and silently provisioning everything but the one step that delivers the mail
 * would look like success and receive nothing.
 */
function resolveRouting(
  zoneId: string | undefined,
  address: string | undefined,
  appWorkerName: string | undefined,
): { zoneId: string; address: string; appWorkerName: string } | undefined {
  if (zoneId && address && appWorkerName) return { zoneId, address, appWorkerName };
  if (!zoneId && !address && !appWorkerName) return undefined;
  throw new ValidationError({
    message: "The inbound routing options are incomplete.",
    action: "Pass --routing-zone, --inbound-address, and --app-worker together, or none of them.",
  });
}

const provision = defineCommand({
  meta: {
    name: "provision",
    description: "Create the support bucket, deploy the classification workers, and route the inbound address",
  },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
    worker: {
      type: "string",
      description:
        "The app worker whose wrangler.jsonc carries the per-environment DB binding (default: the project's only worker)",
    },
    "routing-zone": {
      type: "string",
      description:
        "Cloudflare Zone ID of the (sub)domain receiving the mail — Email Routing must already be enabled on it (its MX points to Cloudflare). Use a subdomain zone (e.g. help.example.com), never your apex, so your primary MX is untouched. Find it on the zone's Overview page.",
    },
    "inbound-address": {
      type: "string",
      description:
        "The exact recipient address the rule matches (e.g. support@help.example.com); mail sent to it is delivered to the app worker's email() handler. It must also be listed in support()'s inboundAddresses, which is what claims it.",
    },
    "app-worker": {
      type: "string",
      description:
        "Deployed name of your production app worker — the one running createEntrypoint with the support capability composed (e.g. pithy-app-production).",
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { provisionSupport } = await loadSupport();
      const { accountId, apiToken } = loadCloudflareCreds(projectDir);
      const supportConfig = await loadSupportConfig(projectDir);
      const appWorker = await resolveSingleWorker({
        projectDir,
        ...(args.worker !== undefined ? { worker: args.worker } : {}),
      });
      const routing = resolveRouting(args["routing-zone"], args["inbound-address"], args["app-worker"]);
      const provisioner = new CloudflareSupportProvisioner({
        cf: new CloudflareClients({ accountId, apiToken }),
        accountId,
        apiToken,
        supportConfig,
        resolveEnv: buildResolveEnv(appWorker),
        ...(routing !== undefined ? { routing } : {}),
        audit: await buildAudit(projectDir, accountId, apiToken, args.worker),
      });

      const result = await provisionSupport(provisioner);

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "support provision", ...result })}\n`);
        return;
      }
      process.stdout.write(
        result.bucket.skipped ? "Attachments are off. No bucket created.\n" : `Bucket ${result.bucket.bucket} ready.\n`,
      );
      process.stdout.write(`${result.environments.length} classification workers deployed.\n`);
      // Say what happened to the index. It is DDL on the adopter's app database, and a provisioning
      // command that silently creates or drops a table is one an operator cannot audit by reading its
      // output. Silence here means it already matched the config, which is also worth saying.
      const created = result.search.filter((entry) => entry.created).map((entry) => entry.env);
      const dropped = result.search.filter((entry) => entry.dropped).map((entry) => entry.env);
      if (created.length > 0) process.stdout.write(`Search index created in ${created.join(", ")}.\n`);
      if (dropped.length > 0) process.stdout.write(`Search index dropped in ${dropped.join(", ")}.\n`);
      if (created.length === 0 && dropped.length === 0) {
        process.stdout.write("Search index already matches your config.\n");
      }
      // Say plainly when no rule was made. Everything else can be right and the inbox still receive
      // nothing, so this is the line an operator needs to read.
      process.stdout.write(
        routing
          ? `Inbound mail for ${routing.address} routes to ${routing.appWorkerName}.\n`
          : "No routing rule. Pass --routing-zone, --inbound-address, and --app-worker to create one.\n",
      );
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const deprovision = defineCommand({
  meta: {
    name: "deprovision",
    description: "Remove the routing rule and the classification workers (optionally the bucket)",
  },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
    worker: {
      type: "string",
      description: "The app worker whose wrangler.jsonc names the database the audit trail is written to",
    },
    storage: {
      type: "boolean",
      default: false,
      description:
        "Also delete the R2 bucket with every attachment and raw message in it (irreversible — this is your support history)",
    },
    "routing-zone": {
      type: "string",
      description:
        "Cloudflare Zone ID the inbound rule lives on. Without it the rule is left in place and mail keeps arriving, because a rule is addressed through its zone and this command will not sweep your domains looking for one.",
    },
    "r2-access-key-id": {
      type: "string",
      description:
        "R2 S3 access key id, required with --storage: a bucket must be emptied over the S3 protocol before R2 will delete it. Falls back to R2_CREDENTIALS in .dev.vars.",
    },
    "r2-secret-access-key": {
      type: "string",
      description:
        "R2 S3 secret access key, paired with --r2-access-key-id. Falls back to R2_CREDENTIALS in .dev.vars.",
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { deprovisionSupport } = await loadSupport();
      const { accountId, apiToken, r2Raw } = loadCloudflareCreds(projectDir);
      // Resolve the key pair up front, before a single worker comes down. A bucket cannot be deleted
      // without it, so discovering it is missing at the bucket step would leave the workers gone and the
      // bucket standing — a half-torn-down inbox for a mistake we can catch here.
      const r2Credentials = args.storage
        ? resolveR2Credentials(args["r2-access-key-id"], args["r2-secret-access-key"], r2Raw)
        : undefined;
      const deprovisioner = new CloudflareSupportDeprovisioner({
        cf: new CloudflareClients({ accountId, apiToken }),
        ...(args["routing-zone"] !== undefined ? { routingZoneId: args["routing-zone"] } : {}),
        ...(r2Credentials !== undefined ? { r2Credentials } : {}),
        audit: await buildAudit(projectDir, accountId, apiToken, args.worker),
      });

      await deprovisionSupport(deprovisioner, { deleteStorage: args.storage });

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({
            command: "support deprovision",
            storageDeleted: args.storage,
            routingZone: args["routing-zone"] ?? null,
          })}\n`,
        );
        return;
      }
      process.stdout.write(
        `Support workers removed${args.storage ? ", including the bucket and everything in it" : ""}.\n`,
      );
      if (!args["routing-zone"]) {
        process.stdout.write("The routing rule was left in place. Pass --routing-zone to remove it.\n");
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});

export default defineCommand({
  meta: { name: "support", description: "Provision and manage the support inbox infrastructure" },
  subCommands: { provision, deprovision },
});
