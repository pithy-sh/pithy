// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { createProjectCliAudit } from "../audit/cliAudit";
import { resolveR2Credentials } from "../capabilities/r2Bucket";
import {
  CloudflareSupportDeprovisioner,
  CloudflareSupportProvisioner,
  loadSupport,
  type SupportEnvResources,
} from "../capabilities/supportProvisioner";
import type { ConfirmedAccount } from "../cloudflare/accountAnswer";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
import { loadProject, loadProjectEnvironments, projectCloudflareAccount, requireProjectName } from "../project/config";
import {
  type EnvironmentReadiness,
  environmentOutcomes,
  environmentReadiness,
  formatEnvironmentOutcomes,
  readyStanza,
  requireReadyEnvironments,
} from "../project/environmentReadiness";
import { projectCapabilities, resolveSingleWorker, resolveWorkers } from "../project/workerScope";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy support provision` / `deprovision` — the command the support manifest and wrangler
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
  // `env` selects the audit database only, and defaults to `dev`: this command spans environments, so no
  // single value is true for the run; each event states the environment it acted on.
  return createProjectCliAudit({ projectDir, accountId, apiToken, ...(worker !== undefined ? { worker } : {}) });
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

/**
 * The Cloudflare credentials this command provisions with, for **the account the project belongs to**.
 *
 * The account is a parameter rather than an ambient, so this cannot resolve before something has
 * established which account the project is for (#206).
 *
 * It also carries **what vouches for the account** (#378). A bare id is what every destructive and
 * creative site here used to hold, and an id alone cannot tell "this account has no such Worker" from
 * "I asked an account nothing claims" — the two arrive as one empty listing.
 */
function loadCloudflareCreds(account: CloudflareAccountSelection | null): {
  account: ConfirmedAccount;
  accountId: string;
  apiToken: string;
  r2Raw: string | undefined;
} {
  const vars = cloudflareEnv({ account });
  const confirmation = cloudflareAccountConfirmation({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: "Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.",
    });
  }
  // No Secrets Store id, unlike email and media: the classification worker binds `DB` and `AI` and holds
  // no credential to decrypt.
  return { account: { accountId, confirmation }, accountId, apiToken, r2Raw: vars.R2_CREDENTIALS };
}

/**
 * Resolve the per-environment app database the classification worker binds, from the **app Worker's**
 * `wrangler.jsonc`.
 *
 * The read and the judgment both happened once already, in {@link environmentReadiness}, before anything
 * was created — so this is a lookup rather than a file read, and an environment with no app database was
 * skipped and reported instead of failing the run part way through (#512). It used to re-read and re-parse
 * that file once per environment per phase, because the provisioner calls this from both `deployWorker`
 * and `ensureSearchIndex`.
 *
 * Which Worker is the app Worker? Every Worker owns its own `wrangler.jsonc`, so a project with several
 * names one with `--worker`; one Worker needs no ceremony. Workers sharing a database share the `DB`
 * binding name, so any Worker carrying the support tables answers the same id.
 */
function buildResolveEnv(readiness: EnvironmentReadiness): (env: ManagedEnvironment) => Promise<SupportEnvResources> {
  return async (env) => ({ appDatabaseId: readyStanza(readiness, env).appDatabaseId });
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
        "Deployed name of your production app worker — the one running createEntrypoint with the support capability composed (e.g. pithy-app-prod).",
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      // The leading segment of the bucket, the classification workers, and the routing rule. The bucket
      // is found by name and reused, so `requireProjectName` refuses to guess — a guessed name adopts
      // another project's inbox (docs/NAMING.md).
      const config = await loadProject(projectDir);
      const project = requireProjectName(config);
      // The project's own environment set (#241): what this command fans out across, rather than a
      // pair the CLI assumed. A project declaring `live` gets `live` provisioned and torn down too.
      const environments = loadProjectEnvironments(config);
      const { provisionSupport } = await loadSupport();
      const { account, accountId, apiToken } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
      const supportConfig = await loadSupportConfig(projectDir);
      const appWorker = await resolveSingleWorker({
        projectDir,
        ...(args.worker !== undefined ? { worker: args.worker } : {}),
      });
      const routing = resolveRouting(args["routing-zone"], args["inbound-address"], args["app-worker"]);
      // Which environments this run can act on, decided once and before the bucket exists. An environment
      // whose app database is not provisioned yet is skipped and reported, never fatal (#512).
      const readiness = await environmentReadiness({
        workerDir: appWorker.dir,
        label: `${appWorker.name}'s wrangler.jsonc`,
        environments,
      });
      const provisioner = new CloudflareSupportProvisioner({
        cf: await cloudflareClients({ accountId, apiToken }),
        project,
        account,
        apiToken,
        supportConfig,
        resolveEnv: buildResolveEnv(readiness),
        ...(routing !== undefined ? { routing } : {}),
        audit: await buildAudit(projectDir, accountId, apiToken, args.worker),
      });

      // The ready list, not the declaration. The bucket and the routing rule are project-global and are
      // created whatever else skips; a skipped environment simply never reaches `deployWorker`.
      const result = await provisionSupport(provisioner, readiness.ready);
      const search = new Map(result.search.map((entry) => [entry.env, entry]));

      if (args.json) {
        // Written before the refusal below, so a run in which everything skipped still carries the
        // per-environment structure on stdout beside the `{"error":…}` line on stderr.
        process.stdout.write(
          `${formatJsonLine({ command: "support provision", ...result, skippedEnvironments: readiness.skipped })}\n`,
        );
        requireReadyEnvironments(readiness, "pithy support provision");
        return;
      }
      process.stdout.write(
        result.bucket.skipped ? "Attachments are off. No bucket created.\n" : `Bucket ${result.bucket.bucket} ready.\n`,
      );
      // One line per declared environment, so a skip reads as a skip. An aggregate count cannot answer
      // "did production get its classification worker", which is the only question this report is for.
      process.stdout.write(
        formatEnvironmentOutcomes(
          environmentOutcomes(readiness, (env) => {
            const entry = search.get(env);
            const index = entry?.created ? ", search index created" : entry?.dropped ? ", search index dropped" : "";
            return `classification worker deployed${index}`;
          }),
        ),
      );
      requireReadyEnvironments(readiness, "pithy support provision");
      // Say what happened to the index. It is DDL on the adopter's app database, and a provisioning
      // command that silently creates or drops a table is one an operator cannot audit by reading its
      // output. The per-environment lines above carry a create or a drop; silence there means it already
      // matched the config, which is also worth saying out loud.
      if (result.search.every((entry) => !entry.created && !entry.dropped)) {
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
        "R2 S3 access key id, required with --storage: a bucket must be emptied over the S3 protocol before R2 will delete it. Falls back to R2_CREDENTIALS in the account config.",
    },
    "r2-secret-access-key": {
      type: "string",
      description:
        "R2 S3 secret access key, paired with --r2-access-key-id. Falls back to R2_CREDENTIALS in the account config.",
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      // Teardown finds resources by recomputing their names, so this must be the same name
      // `provision` used. A guess would match nothing, delete nothing, and still exit 0.
      const config = await loadProject(projectDir);
      const project = requireProjectName(config);
      // The project's own environment set (#241): what this command fans out across, rather than a
      // pair the CLI assumed. A project declaring `live` gets `live` provisioned and torn down too.
      const environments = loadProjectEnvironments(config);
      const { deprovisionSupport } = await loadSupport();
      const { account, accountId, apiToken, r2Raw } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
      // Resolve the key pair up front, before a single worker comes down. A bucket cannot be deleted
      // without it, so discovering it is missing at the bucket step would leave the workers gone and the
      // bucket standing — a half-torn-down inbox for a mistake we can catch here.
      const r2Credentials = args.storage
        ? resolveR2Credentials(args["r2-access-key-id"], args["r2-secret-access-key"], r2Raw)
        : undefined;
      const deprovisioner = new CloudflareSupportDeprovisioner({
        account,
        cf: await cloudflareClients({ accountId, apiToken }),
        project,
        ...(args["routing-zone"] !== undefined ? { routingZoneId: args["routing-zone"] } : {}),
        ...(r2Credentials !== undefined ? { r2Credentials } : {}),
        audit: await buildAudit(projectDir, accountId, apiToken, args.worker),
      });

      await deprovisionSupport(deprovisioner, environments, { deleteStorage: args.storage });

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
