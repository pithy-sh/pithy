// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { type Caller, callerOf, personDecision, rerunCommand } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { isTurnstileCapability } from "@pithy-sh/turnstile/src/capability";
import { type TurnstileConfig, TurnstileMode, TurnstileSitekeys } from "@pithy-sh/turnstile/src/config/config";
import {
  deprovisionTurnstile,
  enabledModes,
  provisionTurnstile,
  type StrandedSitekeyVar,
} from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { defineCommand } from "citty";
import { z } from "zod";
import { createProjectCliAudit } from "../audit/cliAudit";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import { CloudflareTurnstileDeprovisioner, CloudflareTurnstileProvisioner } from "../capabilities/turnstileProvisioner";
import { environmentsBuiltWithoutSitekeys } from "../capabilities/turnstileSitekeys";
import { cloudflareClients } from "../cloudflare/clients";
import { commandCredentials } from "../cloudflare/commandCredentials";
import { withContract } from "../contract/commandContract";
import { resolveCapabilityWorker } from "../project/capabilityWorker";
import {
  loadProject,
  loadProjectEnvironments,
  loadWorkerConfig,
  loadWorkerDomains,
  projectCloudflareAccount,
  requireProjectName,
  type WorkerConfig,
} from "../project/config";
import { type AddressStanza, resolveWorkerAddress } from "../project/workerAddress";
import { workerDirName, workerIdentity } from "../project/workerIdentity";
import { type ResolvedWorker, type ResolveSingleOptions, resolveSingleWorker } from "../project/workerScope";
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
 * The one Worker a turnstile command acts on, and **that Worker's** turnstile config — read from the same
 * place the sitekeys are written to (#590), through {@link resolveCapabilityWorker}, the resolution every
 * capability command that writes into a Worker shares.
 */
export async function resolveTurnstileTarget(
  options: ResolveSingleOptions,
): Promise<{ worker: ResolvedWorker; config: TurnstileConfig }> {
  const { worker, capability } = await resolveCapabilityWorker({
    ...options,
    name: "turnstile",
    is: isTurnstileCapability,
  });
  return { worker, config: capability.turnstileConfig };
}

/**
 * The Worker a deprovision acts on, and its turnstile config — `null` when it composes none (#697).
 *
 * Not {@link resolveTurnstileTarget}'s refusal. The modes deleted are this Worker's own declaration, never a
 * sibling's, so a Worker declaring none has no widget to name: nothing to remove, which `pithy remove` and every
 * idempotent teardown answer with exit 0. A refusal naming `pithy add turnstile` would send a teardown to compose
 * what it is tearing down. A Worker that does not exist is still refused, by the resolver.
 */
export async function resolveTurnstileDeprovisionTarget(
  options: ResolveSingleOptions,
): Promise<{ worker: ResolvedWorker; config: TurnstileConfig | null }> {
  const worker = await resolveSingleWorker(options);
  const capability = worker.capabilities.find(isTurnstileCapability);
  return { worker, config: capability ? capability.turnstileConfig : null };
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
  // The load may fail for a reason this reader forgives; a refused declaration is not one (#665).
  let workerConfig: WorkerConfig | undefined;
  try {
    workerConfig = await loadWorkerConfig(worker.dir);
  } catch {
    workerConfig = undefined;
  }
  const domains = workerConfig === undefined ? undefined : loadWorkerDomains(workerConfig);

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

/** The Worker whose production address the widget binds to, and whose `pithy.config.ts` gets the sitekeys. */
const workerArg = {
  type: "string",
  description:
    "The web-facing worker: its production address binds the widget, its pithy.config.ts gets the sitekeys (default: the project's only worker)",
} as const;

/** An environment list for a sentence: `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * **What `provision` says about a branch deployment, true of the config in front of it (#656 review).**
 *
 * A feature build resolves Cloudflare's always-pass sitekey only where `widgets.<mode>.sitekeys.feature` is
 * absent, and this command never writes that key. So the default is the common case and not the only one: an
 * adopter who stated a real key runs a real widget on a branch, and one who stated `""` renders no widget
 * there at all — where "uses the same test pair by default", printed unconditionally, would tell them
 * sign-in works on the one deployment it does not.
 *
 * Every combination is a true sentence here, including two widgets that disagree, because that is the shape
 * a half-stated config really has.
 */
export function featureSitekeyNote(config: TurnstileConfig, modes: readonly TurnstileMode[]): string {
  const stated = modes.filter((mode) => config.widgets[mode]?.sitekeys.feature !== undefined);
  if (stated.length === 0) {
    return "A feature deployment uses the same test pair by default — nothing to provision, and no redeploy of a branch needed for it.";
  }
  const blank = stated.filter((mode) => config.widgets[mode]?.sitekeys.feature === "");
  const absent = modes.filter((mode) => !stated.includes(mode));
  const parts = [
    `This config states a feature sitekey for ${listed(stated)}, so a branch build uses that rather than the test pair.`,
  ];
  if (blank.length > 0) {
    parts.push(
      `It is blank for ${listed(blank)}, which renders no widget there — sign-in on a branch is blocked until that key is removed or given a real widget's.`,
    );
  }
  if (absent.length > 0) parts.push(`${listed(absent)} still uses the test pair by default.`);
  return parts.join(" ");
}

/** Where each stranded var was, as an operator reads it: `TURNSTILE_SITEKEY_VISIBLE (staging)`. */
/**
 * **Starting over, when the production widgets already existed and their secret was left as-is.** Both commands
 * act on the Worker this run wrote into — a project with several refuses either without `--worker` (#711) — and
 * the provision is the caller's own run again, `--allow-shared-domain` included: without it, the rerun is refused
 * by the domain guard this run was let past.
 */
export function startingOverLine(caller: Caller<"turnstile provision">, worker: { dir: string }): string {
  const named = workerDirName(worker);
  const reprovision = rerunCommand(caller, { flags: { "--worker": named } });
  return `Production widgets already existed; their secret was left as-is. If the production gate returns turnstile/config, starting over is the way through. ${personDecision("turnstile deprovision", { flags: { "--worker": named } })} After it, \`${reprovision}\` writes the secret again.`;
}

function strandedLine(stranded: readonly StrandedSitekeyVar[]): string {
  return stranded.map((found) => `${found.name} (${found.environment})`).join(", ");
}

const Modes = z.array(TurnstileMode).describe("The widget modes this run acted on.");

/** `pithy turnstile provision --json`. `docs/commands/turnstile.md`. */
const TurnstileProvisionPayload = z
  .object({
    command: z.literal("turnstile provision").describe('`"turnstile provision"`.'),
    modes: Modes,
    widgets: z
      .array(
        z
          .object({
            mode: TurnstileMode,
            sitekey: z.string().describe("The production public sitekey."),
            created: z.boolean().describe("Whether this run created the widget; `false` on reuse."),
          })
          .describe("One production widget."),
      )
      .describe("One entry per production widget."),
    productionSecretWritten: z.boolean().describe("Whether the production secret was written this run."),
    sitekeys: z
      .partialRecord(TurnstileMode, TurnstileSitekeys)
      .describe("Per mode, the `dev`, `staging` and `prod` sitekeys written into `pithy.config.ts`."),
    strandedVarsRemoved: z
      .array(
        z
          .object({
            name: z.string().describe("The var's name, e.g. `TURNSTILE_SITEKEY_VISIBLE`."),
            environment: z.string().describe("The environment whose vars held it."),
          })
          .describe("One stranded var."),
      )
      .describe("Each `TURNSTILE_SITEKEY_*` var removed this run."),
    configFile: z.string().describe("The `pithy.config.ts` the sitekeys were written to, project-relative."),
    redeployRequired: z.literal(true).describe("Always: the sitekeys are inlined when the front end is built."),
    environmentsWithoutSitekeys: z
      .array(z.string().describe("An environment."))
      .describe("Every environment built with a front end that no sitekey can reach."),
  })
  .describe("What `pithy turnstile provision` provisioned.");

/** `pithy turnstile deprovision --json`. */
const TurnstileDeprovisionPayload = z
  .object({
    command: z.literal("turnstile deprovision").describe('`"turnstile deprovision"`.'),
    modes: Modes,
  })
  .describe("What `pithy turnstile deprovision` removed.");

const provision = withContract(
  defineCommand({
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
        const { worker, config } = await resolveTurnstileTarget({
          projectDir,
          ...(args.worker !== undefined ? { worker: args.worker } : {}),
        });
        const modes = resolveModes(config);
        const { account, accountId, apiToken } = commandCredentials(await projectCloudflareAccount(projectDir));
        const productionDomain = await resolveProductionDomain(worker);
        const cf = await cloudflareClients({ accountId, apiToken });
        // The project name scopes both the widget names (`<project>-prod-turnstile-<mode>`) and the
        // dispatcher's `<project>-<env>-secrets-write` target — and it is `requireProjectName`, because a
        // guessed one reuses another project's widget and dispatches into its manager (docs/NAMING.md).
        const projectConfig = await loadProject(projectDir);
        const project = requireProjectName(projectConfig);
        // The project's own environment set (#241): what this command fans out across, rather than a
        // pair the CLI assumed. A project declaring `live` gets `live` provisioned and torn down too.
        const environments = loadProjectEnvironments(projectConfig);
        const dispatcher = await buildSecretDispatcher(accountId, apiToken, project);
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

        // The caller's own run, the one input every line naming it again is built from (#711).
        const caller = callerOf("turnstile provision", args);
        const result = await provisionTurnstile(provisioner, {
          modes,
          productionDomain,
          worker: workerDirName(worker),
          caller,
        });
        const configFile = relative(projectDir, join(worker.dir, "pithy.config.ts"));
        // Said here, where an operator believes Turnstile was just enabled: the builds no sitekey can reach.
        const withoutSitekeys = environmentsBuiltWithoutSitekeys(environments);

        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({
              command: "turnstile provision",
              ...result,
              configFile,
              redeployRequired: true,
              environmentsWithoutSitekeys: withoutSitekeys,
            })}\n`,
          );
          return;
        }
        const created = result.widgets.filter((w) => w.created).length;
        process.stdout.write(
          `Test secret wired for dev and staging. ${result.widgets.length} production widget(s) ready (${created} new).\n`,
        );
        // Said here because this is where an operator asks "which environments can sign in now?". A feature
        // deployment is covered by the same pair and by nothing this command wrote: its config and its secrets
        // store are generated per branch, so the kit resolves the pair at build and at the gate (#656) — unless
        // this config states a `feature` sitekey, which `featureSitekeyNote` is what reads.
        process.stdout.write(`${featureSitekeyNote(config, modes)}\n`);
        if (result.widgets.length > 0 && !result.productionSecretWritten) {
          // All production widgets already existed, so their secret can't be recomposed (Cloudflare never
          // returns it) and was left as-is. If it was never stored, re-running won't heal it — say so.
          process.stdout.write(`${startingOverLine(caller, worker)}\n`);
        }
        process.stdout.write(`Sitekeys written to ${configFile} for dev, staging and prod.\n`);
        // The sitekey is inlined when the front end is built, so a deployed bundle still carries the old one.
        process.stdout.write("The build inlines them. Redeploy staging and prod before the widget renders there.\n");
        if (result.strandedVarsRemoved.length > 0) {
          process.stdout.write(`Removed stranded vars nothing read: ${strandedLine(result.strandedVarsRemoved)}.\n`);
        }
        if (withoutSitekeys.length > 0) {
          process.stdout.write(
            `${listed(withoutSitekeys)} ${withoutSitekeys.length === 1 ? "has" : "have"} no sitekey. Builds there render no widget, and sign-in is blocked.\n`,
          );
        }
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: TurnstileProvisionPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

const deprovision = withContract(
  defineCommand({
    meta: {
      name: "deprovision",
      description: "Delete the production widget(s), clear their secrets, and blank the production sitekey",
    },
    args: {
      json: { type: "boolean", default: false, description: "Machine-readable output" },
      worker: { ...workerArg },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const { worker, config } = await resolveTurnstileDeprovisionTarget({
          projectDir,
          ...(args.worker !== undefined ? { worker: args.worker } : {}),
        });
        if (config === null) {
          if (args.json) {
            process.stdout.write(`${formatJsonLine({ command: "turnstile deprovision", modes: [] })}\n`);
            return;
          }
          process.stdout.write(
            `${workerIdentity(worker).worker} does not compose turnstile. Nothing to deprovision.\n`,
          );
          return;
        }
        const modes = resolveModes(config);
        const { account, accountId, apiToken } = commandCredentials(await projectCloudflareAccount(projectDir));
        const cf = await cloudflareClients({ accountId, apiToken });
        // The project name scopes both the widget names teardown recomputes and the dispatcher's
        // `<project>-<env>-secrets-write` target — and it is `requireProjectName`, because a guessed one
        // would delete a neighboring project's widget (docs/NAMING.md).
        const projectConfig = await loadProject(projectDir);
        const project = requireProjectName(projectConfig);
        // The project's own environment set (#241): what this command fans out across, rather than a
        // pair the CLI assumed. A project declaring `live` gets `live` provisioned and torn down too.
        const environments = loadProjectEnvironments(projectConfig);
        const dispatcher = await buildSecretDispatcher(accountId, apiToken, project);
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
        process.stdout.write("Production widget(s) removed. Secrets cleared, and the production sitekey blanked.\n");
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: TurnstileDeprovisionPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

export default defineCommand({
  meta: { name: "turnstile", description: "Provision and manage Turnstile widgets" },
  subCommands: { provision, deprovision },
});
