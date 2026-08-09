// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { isEmailCapability, type ResolvedEmailConfig } from "@pithy-sh/email/src/capability";
import { deprovisionEmail, provisionEmail } from "@pithy-sh/email/src/provision/provisionEmail";
import { type RenderTracking, renderEmail } from "@pithy-sh/email/src/templates/engine";
import { samplePayloads } from "@pithy-sh/email/src/templates/samples";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { parse } from "comment-json";
import { createCliAudit } from "../audit/cliAudit";
import {
  CloudflareEmailDeprovisioner,
  CloudflareEmailProvisioner,
  type EmailEnvResources,
} from "../capabilities/emailProvisioner";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import {
  loadProject,
  loadWorkerConfig,
  loadWorkerDomains,
  projectCloudflareAccount,
  requireProjectName,
} from "../project/config";
import { resolveWorkerAddress } from "../project/workerAddress";
import { projectCapabilities, type ResolvedWorker, resolveSingleWorker, resolveWorkers } from "../project/workerScope";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * The audit emitter for an email command. Provisioning spans every managed environment at once, so
 * there is no single target env to key the audit database on — `"dev"` is the fallback (mirrors
 * `pithy feature`'s convention for env-spanning commands). A no-op when creds or the audit capability
 * aren't there.
 */
async function buildAudit(projectDir: string, accountId: string, apiToken: string) {
  const capabilities = await resolveWorkers({ projectDir })
    .then(projectCapabilities)
    .catch(() => []);
  return createCliAudit({
    projectDir,
    // `env` selects the audit database only. This command spans environments, so no single
    // value is true for the run; each event states the environment it acted on.
    env: "dev",
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/**
 * Load the email capability's resolved config (identity + brand theme). Capabilities live in each Worker's
 * `apps/<name>/pithy.config.ts`, and the config is one brand identity for the project, so the first Worker
 * composing `email` provides it.
 */
async function loadEmailConfig(projectDir: string): Promise<ResolvedEmailConfig> {
  const capabilities = await resolveWorkers({ projectDir }).then(projectCapabilities);
  const cap = capabilities.find(isEmailCapability);
  if (!cap) {
    throw new ValidationError({
      message: "The email capability is not configured.",
      action: "Add `email({ ... })` to a worker's pithy.config.ts (run `pithy add email`).",
    });
  }
  return cap.emailConfig;
}

/**
 * The Cloudflare credentials this command provisions with, for **the account the project belongs to**.
 *
 * The account is a parameter rather than an ambient, so this cannot resolve before something has
 * established which account the project is for (#206).
 */
function loadCloudflareCreds(account: CloudflareAccountSelection | null): {
  accountId: string;
  apiToken: string;
  storeId: string;
} {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  const storeId = vars.SECRETS_STORE_ID ?? "";
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: "Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.",
    });
  }
  if (!storeId) {
    throw new ValidationError({
      message: "The CF Secrets Store id is missing.",
      action: "Run pithy add secrets to record SECRETS_STORE_ID (the email worker decrypts its signing key from it).",
    });
  }
  return { accountId, apiToken, storeId };
}

/** A wrangler env stanza — only the fields the email worker deploy reads from the project's config. */
interface WranglerStanza {
  d1_databases?: { binding: string; database_id?: string }[];
  vars?: Record<string, string>;
  env?: Record<string, WranglerStanza | undefined>;
}

/**
 * Resolve the per-environment resources the email worker binds, from the **app Worker's** `wrangler.jsonc`
 * (the app `DB` id and `BASE_URL` per env) and a live lookup of the env's secrets database. Each missing
 * value throws an actionable error rather than deploying a half-wired worker.
 *
 * Which Worker is the app Worker? Every Worker owns its own `wrangler.jsonc`, so a project with several
 * names one with `--worker`; one Worker needs no ceremony. `BASE_URL` in particular is that Worker's public
 * URL — the address a tracked link resolves back to — so it is not something to guess.
 */
function buildResolveEnv(
  worker: ResolvedWorker,
  cf: CloudflareClients,
  /**
   * The project name the secrets database is found by — `<project>-<env>-secrets`. Resolved once by the
   * caller via `requireProjectName`, never guessed: the lookup is by name, so a wrong one either reports
   * a database that "does not exist" or binds another project's secrets store.
   */
  project: string,
): (env: ManagedEnvironment) => Promise<EmailEnvResources> {
  return async (env) => {
    const path = join(worker.dir, "wrangler.jsonc");
    const config = parse(await readFile(path, "utf8")) as unknown as WranglerStanza;
    const stanza = config.env?.[env];
    if (!stanza) {
      throw new ValidationError({
        message: `${worker.name}'s wrangler.jsonc has no env.${env} stanza.`,
        action: `Add the ${env} environment to ${path} with its DB binding and a BASE_URL var.`,
      });
    }
    const appDatabaseId = stanza.d1_databases?.find((db) => db.binding === "DB")?.database_id;
    if (!appDatabaseId) {
      throw new ValidationError({
        message: `${worker.name}'s wrangler.jsonc env.${env} has no DB database_id.`,
        action: `Provision the ${env} app database and set its id on the DB binding.`,
      });
    }
    // Through the one resolver, which prefers the `domains` declaration and falls back to the route and
    // then to this same var — so an adopter who set it by hand still works, and one who declared a domain
    // is not told to set a var that would only duplicate it. This used to read `vars.BASE_URL` directly
    // with no validation at all, passing whatever string was there through to the deployed email Worker.
    let domains: WorkerDomains | undefined;
    try {
      domains = loadWorkerDomains(await loadWorkerConfig(worker.dir));
    } catch {
      // A malformed declaration must not block provisioning off a good route or var; `pithy env` and
      // `pithy deploy` are where it gets reported.
      domains = undefined;
    }
    const address = resolveWorkerAddress({ environment: env, domains, stanza });
    if (!address) {
      throw new ValidationError({
        message: `${worker.name} has no ${env} address.`,
        action: `Declare it in the Worker's pithy.config.ts — \`domains: { ${env}: { pattern: "…", zone: "…" } }\`. Tracking and unsubscribe links are built against it.`,
        detail: `no domains declaration, route, or vars.BASE_URL resolved for env.${env} in ${path}`,
      });
    }
    const baseUrl = address.url;
    const secretsDb = await cf.d1Provisioner().findDatabaseByName(managerWorkerName(project, env));
    if (!secretsDb) {
      throw new ValidationError({
        message: `The ${env} secrets database (${managerWorkerName(project, env)}) does not exist.`,
        action: "Run `pithy secrets provision` first — the email worker reads its signing key from it.",
      });
    }
    return { appDatabaseId, secretsDatabaseId: secretsDb.uuid, baseUrl };
  };
}

/** The three routing flags, in the order the refusal names them. */
const ROUTING_FLAGS = ["--routing-zone", "--inbound-address", "--app-worker"] as const;

/**
 * The three routing flags, **together or not at all**.
 *
 * Routing is opt-in: the inbound address, its zone, and the worker that answers are an operator choice
 * (and must avoid the apex MX), so none of them is derived and passing none is an ordinary run.
 *
 * A *partial* set is a different thing, and it used to be treated as the same thing — two flags of
 * three wired nothing, said nothing, and exited 0. The consequence is invisible until somebody replies
 * to a message and the mail goes nowhere, by which time nobody is looking at this command. A
 * provisioning command that half-configures a mail path and reports success is worse than one that
 * refuses.
 *
 * `pithy support` makes this decision already (`commands/support.ts` `resolveRouting`); this is the
 * sibling's rule, with the missing flags named — that is the only thing the operator has to type next.
 */
export function resolveRouting(
  zoneId: string | undefined,
  address: string | undefined,
  appWorkerName: string | undefined,
): { zoneId: string; address: string; appWorkerName: string } | undefined {
  if (zoneId && address && appWorkerName) return { zoneId, address, appWorkerName };
  if (!zoneId && !address && !appWorkerName) return undefined;
  const missing = [zoneId, address, appWorkerName]
    .map((value, index) => (value ? undefined : ROUTING_FLAGS[index]))
    .filter((flag): flag is (typeof ROUTING_FLAGS)[number] => flag !== undefined);
  throw new ValidationError({
    message: "The inbound routing options are incomplete.",
    action: `Also pass ${missing.join(" and ")}, or none of the three. Inbound mail is routed only when ${ROUTING_FLAGS.join(", ")} are given together.`,
    detail: `routing flags given: ${ROUTING_FLAGS.filter((flag) => !missing.includes(flag)).join(", ")}`,
  });
}

const provision = defineCommand({
  meta: { name: "provision", description: "Provision the shared suppression DB and per-environment email workers" },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
    worker: {
      type: "string",
      description:
        "The app worker whose wrangler.jsonc carries the per-environment DB binding and BASE_URL (default: the project's only worker)",
    },
    "routing-zone": {
      type: "string",
      description:
        "Cloudflare Zone ID of the (sub)domain receiving the mail — Email Routing must already be enabled on it (its MX points to Cloudflare). Use a subdomain zone (e.g. bounce.example.com), never your apex, so your primary MX is untouched. Find it on the zone's Overview page.",
    },
    "inbound-address": {
      type: "string",
      description:
        "The exact recipient address the rule matches (e.g. bounce@bounce.example.com); mail sent to it is delivered to the app worker's email() handler.",
    },
    "app-worker": {
      type: "string",
      description:
        "Deployed name of your production app worker — the one running createEntrypoint with the email() bounce handler (e.g. pithy-app-prod).",
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      // First, before the project name, the credentials, and every Cloudflare call: a mistyped or
      // half-remembered flag set must cost nothing and must not provision anything.
      const routing = resolveRouting(args["routing-zone"], args["inbound-address"], args["app-worker"]);
      // The leading segment of the suppression database, the email workers, and the bounce rule. The
      // database is found by name and reused, so `requireProjectName` refuses to guess — a guessed name
      // adopts another project's opt-out list (docs/NAMING.md).
      const project = requireProjectName(await loadProject(projectDir));
      const { accountId, apiToken, storeId } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
      const { theme } = await loadEmailConfig(projectDir);
      const appWorker = await resolveSingleWorker({
        projectDir,
        ...(args.worker !== undefined ? { worker: args.worker } : {}),
      });
      const cf = new CloudflareClients({ accountId, apiToken });
      const provisioner = new CloudflareEmailProvisioner({
        cf,
        project,
        accountId,
        apiToken,
        storeId,
        theme,
        resolveEnv: buildResolveEnv(appWorker, cf, project),
        routing,
        audit: await buildAudit(projectDir, accountId, apiToken),
      });

      const result = await provisionEmail(provisioner);

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "email provision", ...result })}\n`);
        return;
      }
      process.stdout.write(`Suppression database and ${result.environments.length} email workers ready.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const deprovision = defineCommand({
  meta: { name: "deprovision", description: "Remove the email workers (and optionally the suppression DB)" },
  args: {
    suppression: {
      type: "boolean",
      default: false,
      description: "Also delete this project's suppression DB (irreversible)",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      // Teardown finds resources by recomputing their names, so this must be the same name
      // `provision` used. A guess would match nothing, delete nothing, and still exit 0.
      const project = requireProjectName(await loadProject(projectDir));
      const { accountId, apiToken } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
      const cf = new CloudflareClients({ accountId, apiToken });
      const deprovisioner = new CloudflareEmailDeprovisioner({
        cf,
        project,
        audit: await buildAudit(projectDir, accountId, apiToken),
      });

      await deprovisionEmail(deprovisioner, { deleteSuppression: args.suppression });

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({ command: "email deprovision", suppressionDeleted: args.suppression })}\n`,
        );
        return;
      }
      process.stdout.write(`Email workers removed${args.suppression ? ", including the suppression database" : ""}.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const test = defineCommand({
  meta: { name: "test", description: "Render one template through your config and send it to an address" },
  args: {
    to: { type: "string", description: "Recipient address", required: true },
    template: { type: "string", default: "welcome", description: "Template id (e.g. magicLink, newsletter)" },
    from: { type: "string", description: "Override the configured from address" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { accountId, apiToken } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
      const { fromAddress, fromName, baseUrl, theme } = await loadEmailConfig(projectDir);
      const payload = samplePayloads[args.template];
      if (!payload) {
        throw new ValidationError({
          message: `No sample payload for template "${args.template}".`,
          action: `Known templates: ${Object.keys(samplePayloads).join(", ")}.`,
        });
      }

      // A throwaway tracking context so any template (incl. marketing, which forces an unsubscribe link)
      // renders. Links are not actually tracked — this is a visual/delivery check of the config.
      const tracking: RenderTracking = {
        baseUrl,
        jobId: "test",
        recipient: args.to,
        key: "email-test-preview-key",
        kid: "test",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        openTracking: false,
        clickTracking: false,
      };
      const rendered = await renderEmail(args.template, payload, theme, tracking);
      const from = args.from ?? fromAddress;
      const result = await new CloudflareClients({ accountId, apiToken }).email().send({
        to: args.to,
        from: { email: from, name: fromName },
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({ command: "email test", template: args.template, to: args.to, from, messageId: result.messageId })}\n`,
        );
        return;
      }
      process.stdout.write(
        `Sent "${args.template}" from ${from} to ${args.to}${result.messageId ? ` (${result.messageId})` : ""}.\n`,
      );
      process.stdout.write(`${formatDone()}\n`);
    }),
});

export default defineCommand({
  meta: { name: "email", description: "Provision and manage the email infrastructure" },
  subCommands: { provision, deprovision, test },
});
