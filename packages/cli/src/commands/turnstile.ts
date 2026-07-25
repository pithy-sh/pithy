import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { isTurnstileCapability } from "@pithy-sh/turnstile/src/capability";
import type { TurnstileConfig, TurnstileMode } from "@pithy-sh/turnstile/src/config/config";
import {
  deprovisionTurnstile,
  enabledModes,
  provisionTurnstile,
} from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { defineCommand } from "citty";
import { createCliAudit } from "../audit/cliAudit";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import { CloudflareTurnstileDeprovisioner, CloudflareTurnstileProvisioner } from "../capabilities/turnstileProvisioner";
import { allCapabilities, loadProject } from "../project/config";
import { readWranglerConfig, type WranglerEnvVars } from "../project/wrangler";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * The audit emitter for a turnstile command. Provisioning spans every managed environment at once, so
 * there is no single target env to key the audit database on — `"dev"` is the fallback (mirrors
 * `pithy feature`'s convention for env-spanning commands). A no-op when creds or the audit capability
 * aren't there.
 */
async function buildAudit(projectDir: string, accountId: string, apiToken: string) {
  const capabilities = await loadProject(projectDir)
    .then(allCapabilities)
    .catch(() => []);
  return createCliAudit({
    projectDir,
    env: "dev",
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/** Load the turnstile capability's resolved config from `pithy.config.ts`. */
async function loadTurnstileConfig(projectDir: string): Promise<TurnstileConfig> {
  const config = await loadProject(projectDir);
  const cap = allCapabilities(config).find(isTurnstileCapability);
  if (!cap) {
    throw new ValidationError({
      message: "The turnstile capability is not configured.",
      action: "Add `turnstile({ ... })` to pithy.config.ts (run `pithy add turnstile`).",
    });
  }
  return cap.turnstileConfig;
}

/** The widget modes declared in config, or an actionable error when none are. */
function resolveModes(config: TurnstileConfig): TurnstileMode[] {
  const modes = enabledModes(config);
  if (modes.length === 0) {
    throw new ValidationError({
      message: "No Turnstile widgets are declared.",
      action: "Add a `widgets.visible` or `widgets.invisible` entry to turnstile({ ... }) in pithy.config.ts.",
    });
  }
  return modes;
}

/** The CF credentials provisioning needs, from `.dev.vars` then `process.env`. */
function loadCloudflareCreds(projectDir: string): { accountId: string; apiToken: string } {
  const vars = loadCloudflareEnv(projectDir);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .dev.vars.",
    });
  }
  return { accountId, apiToken };
}

/** Resolve the production domain (hostname) the real widget binds to, from `wrangler.jsonc`. */
async function resolveProductionDomain(projectDir: string): Promise<string> {
  const config = (await readWranglerConfig(projectDir)) as WranglerEnvVars;
  const baseUrl = config.env?.production?.vars?.BASE_URL;
  if (!baseUrl) {
    throw new ValidationError({
      message: "wrangler.jsonc env.production has no BASE_URL var.",
      action: "Set vars.BASE_URL to the production app URL; the Turnstile widget binds to its domain.",
    });
  }
  // Accept either a full URL or a bare host[:port][/path]; prepend a scheme when absent so `URL` extracts
  // the hostname (a scheme-less `host:port` otherwise parses the host as a protocol and yields no hostname).
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  let hostname = "";
  try {
    hostname = new URL(candidate).hostname;
  } catch {
    hostname = "";
  }
  if (!hostname) {
    throw new ValidationError({
      message: `wrangler.jsonc env.production BASE_URL ("${baseUrl}") is not a valid URL or hostname.`,
      action: "Set vars.BASE_URL to the production app URL, e.g. https://app.example.com.",
    });
  }
  return hostname;
}

const provision = defineCommand({
  meta: {
    name: "provision",
    description: "Wire Turnstile test keys (dev/staging) and provision the production widget",
  },
  args: { json: { type: "boolean", default: false, description: "Machine-readable output" } },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const config = await loadTurnstileConfig(projectDir);
      const modes = resolveModes(config);
      const { accountId, apiToken } = loadCloudflareCreds(projectDir);
      const productionDomain = await resolveProductionDomain(projectDir);
      const cf = new CloudflareClients({ accountId, apiToken });
      const dispatcher = buildSecretDispatcher(accountId, apiToken);
      const audit = await buildAudit(projectDir, accountId, apiToken);
      const provisioner = new CloudflareTurnstileProvisioner({ cf, projectDir, dispatcher, audit });

      const result = await provisionTurnstile(provisioner, { modes, productionDomain });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "turnstile provision", ...result })}\n`);
        return;
      }
      const created = result.widgets.filter((w) => w.created).length;
      process.stdout.write(
        `Test secret wired for dev and staging. ${result.widgets.length} production widget(s) ready (${created} new).\n`,
      );
      if (result.widgets.length > 0 && !result.productionSecretWritten) {
        // All production widgets already existed, so their secret can't be recomposed (Cloudflare never
        // returns it) and was left as-is. If it was never stored, re-running won't heal it — say so.
        process.stdout.write(
          "Production widgets already existed; their secret was left as-is. If the production gate returns turnstile/config, run `pithy turnstile deprovision` then provision again.\n",
        );
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const deprovision = defineCommand({
  meta: { name: "deprovision", description: "Delete the production widget(s) and clear Turnstile config" },
  args: { json: { type: "boolean", default: false, description: "Machine-readable output" } },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const config = await loadTurnstileConfig(projectDir);
      const modes = resolveModes(config);
      const { accountId, apiToken } = loadCloudflareCreds(projectDir);
      const cf = new CloudflareClients({ accountId, apiToken });
      const dispatcher = buildSecretDispatcher(accountId, apiToken);
      const audit = await buildAudit(projectDir, accountId, apiToken);
      const deprovisioner = new CloudflareTurnstileDeprovisioner({ cf, projectDir, dispatcher, audit });

      const result = await deprovisionTurnstile(deprovisioner, modes);

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "turnstile deprovision", ...result })}\n`);
        return;
      }
      process.stdout.write(`Production widget(s) removed and config cleared.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});

export default defineCommand({
  meta: { name: "turnstile", description: "Provision and manage Turnstile widgets" },
  subCommands: { provision, deprovision },
});
