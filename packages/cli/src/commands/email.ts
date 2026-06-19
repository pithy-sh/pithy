import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { isEmailCapability, type ResolvedEmailConfig } from "@pithy-sh/email/src/capability";
import { deprovisionEmail, provisionEmail } from "@pithy-sh/email/src/provision/provisionEmail";
import { type RenderTracking, renderEmail } from "@pithy-sh/email/src/templates/engine";
import { samplePayloads } from "@pithy-sh/email/src/templates/samples";
import { managerWorkerName } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { parse } from "comment-json";
import {
  CloudflareEmailDeprovisioner,
  CloudflareEmailProvisioner,
  type EmailEnvResources,
} from "../capabilities/emailProvisioner";
import { allCapabilities, loadProject } from "../project/config";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/** Load the email capability's resolved config (from identity + brand theme) from `pithy.config.ts`. */
async function loadEmailConfig(projectDir: string): Promise<ResolvedEmailConfig> {
  const config = await loadProject(projectDir);
  const cap = allCapabilities(config).find(isEmailCapability);
  if (!cap) {
    throw new ValidationError({
      message: "The email capability is not configured.",
      action: "Add `email({ ... })` to pithy.config.ts (run `pithy add email`).",
    });
  }
  return cap.emailConfig;
}

/** The CF credentials and Secrets Store id email provisioning needs, from `.dev.vars` then `process.env`. */
function loadCloudflareCreds(projectDir: string): { accountId: string; apiToken: string; storeId: string } {
  const vars = loadCloudflareEnv(projectDir);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  const storeId = vars.SECRETS_STORE_ID ?? "";
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .dev.vars.",
    });
  }
  if (!storeId) {
    throw new ValidationError({
      message: "The CF Secrets Store id is missing.",
      action: "Set SECRETS_STORE_ID in .dev.vars (the email worker decrypts its signing key from it).",
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
 * Resolve the per-environment resources the email worker binds, from the project's `wrangler.jsonc`
 * (the app `DB` id and `BASE_URL` per env) and a live lookup of the env's secrets database. Each missing
 * value throws an actionable error rather than deploying a half-wired worker.
 */
function buildResolveEnv(
  projectDir: string,
  cf: CloudflareClients,
): (env: ManagedEnvironment) => Promise<EmailEnvResources> {
  return async (env) => {
    const config = parse(await readFile(join(projectDir, "wrangler.jsonc"), "utf8")) as unknown as WranglerStanza;
    const stanza = config.env?.[env];
    if (!stanza) {
      throw new ValidationError({
        message: `wrangler.jsonc has no env.${env} stanza.`,
        action: `Add the ${env} environment to wrangler.jsonc with its DB binding and a BASE_URL var.`,
      });
    }
    const appDatabaseId = stanza.d1_databases?.find((db) => db.binding === "DB")?.database_id;
    if (!appDatabaseId) {
      throw new ValidationError({
        message: `wrangler.jsonc env.${env} has no DB database_id.`,
        action: `Provision the ${env} app database and set its id on the DB binding.`,
      });
    }
    const baseUrl = stanza.vars?.BASE_URL;
    if (!baseUrl) {
      throw new ValidationError({
        message: `wrangler.jsonc env.${env} has no BASE_URL var.`,
        action: `Set vars.BASE_URL to the ${env} app worker's public URL (tracking links are built against it).`,
      });
    }
    const secretsDb = await cf.d1Provisioner().findDatabaseByName(managerWorkerName(env));
    if (!secretsDb) {
      throw new ValidationError({
        message: `The ${env} secrets database (${managerWorkerName(env)}) does not exist.`,
        action: "Run `pithy secrets provision` first — the email worker reads its signing key from it.",
      });
    }
    return { appDatabaseId, secretsDatabaseId: secretsDb.uuid, baseUrl };
  };
}

const provision = defineCommand({
  meta: { name: "provision", description: "Provision the shared suppression DB and per-environment email workers" },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
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
        "Deployed name of your production app worker — the one running createEntrypoint with the email() bounce handler (e.g. pithy-app-production).",
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { accountId, apiToken, storeId } = loadCloudflareCreds(projectDir);
      const { theme } = await loadEmailConfig(projectDir);
      const cf = new CloudflareClients({ accountId, apiToken });
      // Routing is wired only when all three pieces are given — the inbound address/zone/worker are an
      // operator choice (and must avoid the apex MX), so it's opt-in, not derived.
      const routing =
        args["routing-zone"] && args["inbound-address"] && args["app-worker"]
          ? { zoneId: args["routing-zone"], address: args["inbound-address"], appWorkerName: args["app-worker"] }
          : undefined;
      const provisioner = new CloudflareEmailProvisioner({
        cf,
        accountId,
        apiToken,
        storeId,
        theme,
        resolveEnv: buildResolveEnv(projectDir, cf),
        routing,
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
      description: "Also delete the shared suppression DB (irreversible)",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const { accountId, apiToken } = loadCloudflareCreds(process.cwd());
      const cf = new CloudflareClients({ accountId, apiToken });
      const deprovisioner = new CloudflareEmailDeprovisioner({ cf });

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
      const { accountId, apiToken } = loadCloudflareCreds(projectDir);
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
