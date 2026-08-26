// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { isTurnstileCapability } from "@pithy-sh/turnstile/src/capability";
import type { TurnstileConfig, TurnstileMode } from "@pithy-sh/turnstile/src/config/config";
import {
  deprovisionTurnstile,
  enabledModes,
  provisionTurnstile,
} from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { defineCommand } from "citty";
import { createProjectCliAudit } from "../audit/cliAudit";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import { CloudflareTurnstileDeprovisioner, CloudflareTurnstileProvisioner } from "../capabilities/turnstileProvisioner";
import type { ConfirmedAccount } from "../cloudflare/accountAnswer";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
import {
  loadProject,
  loadProjectEnvironments,
  loadWorkerConfig,
  loadWorkerDomains,
  projectCloudflareAccount,
  requireProjectName,
} from "../project/config";
import { type AddressStanza, resolveWorkerAddress } from "../project/workerAddress";
import { projectCapabilities, type ResolvedWorker, resolveSingleWorker, resolveWorkers } from "../project/workerScope";
import { readWranglerConfig } from "../project/wrangler";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * The audit emitter for a turnstile command. Provisioning spans every managed environment at once, so
 * there is no single target env to key the audit database on — `"dev"` is the fallback (mirrors
 * `pithy feature`'s convention for env-spanning commands). A no-op when creds or the audit capability
 * aren't there.
 */
async function buildAudit(projectDir: string, accountId: string, apiToken: string) {
  // `env` selects the audit database only, and defaults to `dev`: this command spans environments, so no
  // single value is true for the run; each event states the environment it acted on.
  return createProjectCliAudit({ projectDir, accountId, apiToken });
}

/**
 * Load the turnstile capability's resolved config. Capabilities live in each Worker's
 * `apps/<name>/pithy.config.ts`; the widget set is one project-wide decision, so the first Worker composing
 * `turnstile` provides it.
 */
async function loadTurnstileConfig(projectDir: string): Promise<TurnstileConfig> {
  const capabilities = await resolveWorkers({ projectDir }).then(projectCapabilities);
  const cap = capabilities.find(isTurnstileCapability);
  if (!cap) {
    throw new ValidationError({
      message: "The turnstile capability is not configured.",
      action: "Add `turnstile({ ... })` to a worker's pithy.config.ts (run `pithy add turnstile`).",
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
  return { account: { accountId, confirmation }, accountId, apiToken };
}

/**
 * Resolve the production hostname the real widget binds to, through the one address resolver.
 *
 * A Turnstile widget is bound to the domain a human loads it on, so this needs a hostname rather than a
 * URL — the resolver returns both and this takes the `hostname` half.
 *
 * Single-environment by design: a widget binds to production, so `prod` is not a parameter. Every Worker
 * has its own address, so a project with several names one with `--worker` rather than have a widget
 * silently bound to the wrong host.
 *
 * This used to read `env.prod.vars.BASE_URL` directly, with its own parser and its own two errors — one
 * of the three unreconciled derivations #89 replaced. The resolver now prefers the `domains` declaration
 * and falls back to the route and then to that same var, so an adopter who set it by hand still works and
 * one who declared a domain is no longer told to set a var that would duplicate it.
 */
async function resolveProductionDomain(worker: ResolvedWorker): Promise<string> {
  const stanza = ((await readWranglerConfig(worker.dir)) as { env?: Record<string, AddressStanza | undefined> }).env
    ?.prod;
  let domains: WorkerDomains | undefined;
  try {
    domains = loadWorkerDomains(await loadWorkerConfig(worker.dir));
  } catch {
    // A malformed declaration must not stop a widget being provisioned off a perfectly good route or
    // var. `pithy env` and `pithy deploy` are where a bad `domains` block gets reported.
    domains = undefined;
  }

  const address = resolveWorkerAddress({ environment: "prod", domains, stanza });
  if (!address) {
    throw new ValidationError({
      message: `${worker.name} has no production address.`,
      action:
        'Declare it in the Worker\'s pithy.config.ts — `domains: { prod: { pattern: "app.example.com", zone: "example.com" } }`. The Turnstile widget binds to that domain.',
      detail: `no domains declaration, route, or vars.BASE_URL resolved for env.prod in ${worker.dir}`,
    });
  }
  return address.hostname;
}

/** The Worker whose `wrangler.jsonc` carries the production `BASE_URL` and the per-env sitekey vars. */
const workerArg = {
  type: "string",
  description: "The web-facing worker whose wrangler.jsonc holds BASE_URL (default: the project's only worker)",
} as const;

const provision = defineCommand({
  meta: {
    name: "provision",
    description: "Wire Turnstile test keys (dev/staging) and provision the production widget",
  },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
    worker: { ...workerArg },
    "allow-shared-domain": {
      type: "boolean",
      default: false,
      description: "Provision even though another Turnstile widget already covers the domain",
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const config = await loadTurnstileConfig(projectDir);
      const modes = resolveModes(config);
      const { account, accountId, apiToken } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
      const worker = await resolveSingleWorker({
        projectDir,
        ...(args.worker !== undefined ? { worker: args.worker } : {}),
      });
      const productionDomain = await resolveProductionDomain(worker);
      const cf = new CloudflareClients({ accountId, apiToken });
      // The project name scopes both the widget names (`<project>-prod-turnstile-<mode>`) and the
      // dispatcher's `<project>-<env>-secrets-write` target — and it is `requireProjectName`, because a
      // guessed one reuses another project's widget and dispatches into its manager (docs/NAMING.md).
      const projectConfig = await loadProject(projectDir);
      const project = requireProjectName(projectConfig);
      // The project's own environment set (#241): what this command fans out across, rather than a
      // pair the CLI assumed. A project declaring `live` gets `live` provisioned and torn down too.
      const environments = loadProjectEnvironments(projectConfig);
      const dispatcher = buildSecretDispatcher(accountId, apiToken, project);
      const audit = await buildAudit(projectDir, accountId, apiToken);
      const provisioner = new CloudflareTurnstileProvisioner({
        cf,
        account,
        project,
        projectDir,
        workerDir: worker.dir,
        dispatcher,
        environments,
        audit,
      });

      const result = await provisionTurnstile(provisioner, {
        modes,
        productionDomain,
        allowSharedDomain: args["allow-shared-domain"],
      });

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
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
    worker: { ...workerArg },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const config = await loadTurnstileConfig(projectDir);
      const modes = resolveModes(config);
      const { account, accountId, apiToken } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
      const worker = await resolveSingleWorker({
        projectDir,
        ...(args.worker !== undefined ? { worker: args.worker } : {}),
      });
      const cf = new CloudflareClients({ accountId, apiToken });
      // The project name scopes both the widget names teardown recomputes and the dispatcher's
      // `<project>-<env>-secrets-write` target — and it is `requireProjectName`, because a guessed one
      // would delete a neighboring project's widget (docs/NAMING.md).
      const projectConfig = await loadProject(projectDir);
      const project = requireProjectName(projectConfig);
      // The project's own environment set (#241): what this command fans out across, rather than a
      // pair the CLI assumed. A project declaring `live` gets `live` provisioned and torn down too.
      const environments = loadProjectEnvironments(projectConfig);
      const dispatcher = buildSecretDispatcher(accountId, apiToken, project);
      const audit = await buildAudit(projectDir, accountId, apiToken);
      const deprovisioner = new CloudflareTurnstileDeprovisioner({
        cf,
        account,
        project,
        projectDir,
        workerDir: worker.dir,
        dispatcher,
        environments,
        audit,
      });

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
