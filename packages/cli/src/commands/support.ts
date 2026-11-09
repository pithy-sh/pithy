// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { callerOf, rerunRemedy } from "@pithy-sh/core/src/cli/command";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { z } from "zod";
import { createProjectCliAudit } from "../audit/cliAudit";
import { provisionHostOwner } from "../capabilities/hostRegistry";
import { projectHostOwners } from "../capabilities/hostWorkflows";
import { resolveR2Credentials } from "../capabilities/r2Bucket";
import {
  CloudflareSupportDeprovisioner,
  CloudflareSupportProvisioner,
  loadSupport,
  removeEnvironmentRoutes,
  SUPPORT_VECTORIZE_BINDING,
  type SupportEnvResources,
  type SupportEnvRouting,
  type SupportModule,
  SupportRoute,
  SupportRouteRemoval,
} from "../capabilities/supportProvisioner";
import { cloudflareClients, cloudflareWorkflows } from "../cloudflare/clients";
import { commandCredentials } from "../cloudflare/commandCredentials";
import { withContract } from "../contract/commandContract";
import { applyAppBindings, removeAppVectorize } from "../project/appBindings";
import { resolveCapabilityWorker } from "../project/capabilityWorker";
import { composeFor } from "../project/composeFor";
import { loadProject, loadProjectEnvironments, projectCloudflareAccount, requireProjectName } from "../project/config";
import { requireTeardownEnvironment, TEARDOWN_ENV_ARG } from "../project/environment";
import {
  type EnvironmentReadiness,
  environmentOutcomes,
  environmentReadiness,
  formatEnvironmentOutcomes,
  ProvisionReportExitCode,
  readyStanza,
  requireReadyEnvironments,
  SkippedEnvironment,
  writeProvisionReport,
} from "../project/environmentReadiness";
import { serviceScripts } from "../project/serviceStanzas";
import { confineTeardown } from "../project/teardown";
import { workerDirName } from "../project/workerIdentity";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy support provision` / `deprovision` — the command the support manifest and wrangler
 * template have always pointed at. It creates the `SUPPORT_BUCKET` R2 bucket, deploys the prebuilt
 * classification worker for every managed environment, and routes each environment's inbound address to
 * that environment's app worker.
 *
 * **The route is derived, and Email Routing is never enabled here.** Each environment's composition names
 * its `inboundAddresses`; the zone is the one holding the address's domain; the Worker is the one `pithy
 * deploy` names for the environment. Enabling Email Routing points a domain's MX at Cloudflare, so a domain
 * it is not enabled for is refused by name and left to the operator. The three routing flags, together,
 * replace the derivation with the one project-global rule they describe.
 *
 * **No secret is written, and nothing else writes the one support needs either.** The classification
 * worker reads a message and writes a label over the `AI` binding, so it carries no credential. The R2
 * key pair support presigns attachments with is `support-r2-credentials` — its own entry, read by
 * `support/src/http/resolve.ts` — and no command in the kit creates it: `pithy storage provision` writes
 * `storage-r2-credentials`, which is a different secret for a different bucket. So the operator writes
 * support's, and `pithy doctor`'s `shared:` section is where that is said out loud when the bucket moves.
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

/**
 * What one environment's line says about its message index. A backfill is named whether or not this run
 * created the index, because re-running after a failed first run is how an existing, unstamped index gets one.
 */
export function messageIndexOutcome(
  vectors: { created: boolean; dropped: boolean; backfilled: boolean } | undefined,
): string {
  if (vectors?.created) return `, message index created${vectors.backfilled ? " and backfilling" : ""}`;
  if (vectors?.backfilled) return ", message index backfilling";
  if (vectors?.dropped) return ", message index dropped";
  return "";
}

/**
 * Resolve the per-environment app database the classification worker binds, from the **app Worker's**
 * `wrangler.jsonc`.
 *
 * The read and the judgment both happen once, in {@link environmentReadiness}, before anything is created — so
 * this is a lookup rather than a file read, and an environment with no app database is skipped and reported
 * instead of failing the run part way through. The provisioner calls this from both `deployWorker` and
 * `ensureSearchIndex`, so a read here would parse the file once per environment per phase.
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
 * A partial set is rejected rather than quietly treated as "no override": an operator who passed two of three
 * asked for a rule, and routing something else in its place would look like success and deliver elsewhere.
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

/**
 * One environment's routing, from that environment's own composition: the addresses support claims there, and the
 * script the app Worker deploys as there. A composition that cannot be read for the environment is a refusal for it,
 * with the composition's own sentence, and never a failed run.
 */
async function environmentRouting(options: {
  projectDir: string;
  project: string;
  env: ManagedEnvironment;
  worker: string | undefined;
  isSupportCapability: SupportModule["isSupportCapability"];
}): Promise<SupportEnvRouting> {
  const { projectDir, project, env } = options;
  try {
    const { worker, capability } = await composeFor(env, (load) =>
      resolveCapabilityWorker({
        projectDir,
        ...(options.worker !== undefined ? { worker: options.worker } : {}),
        name: "support",
        is: options.isSupportCapability,
        loadConfig: load,
      }),
    );
    const app = workerDirName(worker);
    const scripts = await serviceScripts(project, [{ app, dir: worker.dir, deployedAs: worker.name }]);
    return { env, addresses: capability.supportConfig.inboundAddresses, workerName: scripts(app, env) };
  } catch (error) {
    if (!(error instanceof PithyError)) throw error;
    return { env, addresses: [], workerName: null, refused: error.payload.message };
  }
}

/** One settled route, as the human report says it. */
function routeLine(route: SupportRoute): string {
  const prefix = route.env === null ? "" : `${route.env}: `;
  const on = route.zone === null ? "" : `, on ${route.zone}`;
  switch (route.outcome) {
    case "created":
      return `${prefix}${route.address} now routes to ${route.worker}${on}.`;
    case "updated":
      return `${prefix}${route.address} now routes to ${route.worker}${on}. Its rule sent it elsewhere.`;
    case "unchanged":
      return `${prefix}${route.address} already routes to ${route.worker}${on}.`;
    default:
      return `${prefix}No routing rule. ${route.reason ?? ""}`.trimEnd();
  }
}

/** One environment's removed route, as the human report says it. */
function removalLine(removal: SupportRouteRemoval): string {
  switch (removal.outcome) {
    case "removed":
      return `${removal.env}: ${removal.address} no longer routes to ${removal.worker}.`;
    case "absent":
      return `${removal.env}: no rule sent ${removal.address} to ${removal.worker}.`;
    default:
      return `${removal.env}: routing left alone. ${removal.reason ?? ""}`.trimEnd();
  }
}

/**
 * Write each environment's `SUPPORT_VECTORIZE` entry into the app Worker's `wrangler.jsonc` while
 * `search.semantic` is on, and take it out once the index is gone: a binding to a deleted index fails the
 * next deploy.
 */
export async function recordSemanticBindings(
  workerDir: string,
  supportConfig: { search: { semantic: unknown } },
  entries: readonly { env: string; indexName: string; dropped: boolean }[],
): Promise<void> {
  for (const entry of entries) {
    if (supportConfig.search.semantic !== false && !entry.dropped) {
      await applyAppBindings(workerDir, entry.env, {
        vectorize: [{ binding: SUPPORT_VECTORIZE_BINDING, index_name: entry.indexName, remote: true }],
      });
    } else {
      await removeAppVectorize(workerDir, entry.env, SUPPORT_VECTORIZE_BINDING);
    }
  }
}

const Skipped = z
  .array(SkippedEnvironment)
  .describe("One entry per declared environment nothing was provisioned for. Empty when none was skipped.");

/** `pithy support provision --json`. `docs/commands/support.md`. */
const SupportProvisionPayload = z
  .object({
    command: z.literal("support provision").describe('`"support provision"`.'),
    bucket: z
      .object({
        bucket: z.string().describe("The project's support bucket."),
        created: z.boolean().describe("Whether this run created it."),
        skipped: z.boolean().describe("Whether it was not asked for."),
      })
      .describe("The shared support bucket."),
    environments: z.array(z.string().describe("An environment.")).describe("The environments provisioned."),
    search: z
      .array(
        z
          .object({
            env: z.string().describe("The environment."),
            created: z.boolean().describe("Whether the search index was created."),
            dropped: z.boolean().describe("Whether a stale one was dropped."),
            repaired: z.boolean().describe("Whether its triggers were repaired."),
          })
          .describe("One environment's search index."),
      )
      .describe("Each environment's full-text search index."),
    semantic: z
      .array(
        z
          .object({
            env: z.string().describe("The environment."),
            indexName: z
              .string()
              .describe(
                "The environment's message index, `<project>-<env>-support-messages`, or `<project>-<env>-<worker>---support-messages` for a Worker's own host.",
              ),
            created: z.boolean().describe("Whether this run created it."),
            dropped: z.boolean().describe("Whether this run dropped it, because `search.semantic` is off."),
            backfilled: z
              .boolean()
              .describe(
                "Whether this run started the index's one backfill: for an index it created, or one that holds no stamp while inbound mail exists.",
              ),
          })
          .describe("One environment's semantic message index."),
      )
      .optional()
      .describe(
        "Each environment's semantic message index. Absent when the installed `@pithy-sh/support` has no semantic search.",
      ),
    routing: z
      .object({
        created: z.boolean().describe("Whether this run created or updated an inbound routing rule."),
        skipped: z.boolean().describe("Whether there was nothing to route: every environment claims no address."),
      })
      .describe("The inbound routing rules, in sum. `inboundRoutes` has each one."),
    inboundRoutes: z
      .array(SupportRoute)
      .describe(
        "Each inbound routing rule this run settled: one per address per provisioned environment, or the one the three routing flags name.",
      ),
    skippedEnvironments: Skipped,
    exitCode: ProvisionReportExitCode,
  })
  .describe("What `pithy support provision` provisioned.");

/** `pithy support deprovision --json`. */
const SupportDeprovisionPayload = z
  .object({
    command: z.literal("support deprovision").describe('`"support deprovision"`.'),
    env: z.string().describe("The environment torn down."),
    storageDeleted: z.boolean().describe("Whether the support bucket was deleted with it."),
    routingZone: z
      .string()
      .nullable()
      .describe(
        "The zone whose project-global routing rule (the one the three routing flags create) was removed, or `null` when it was left.",
      ),
    inboundRoutes: z
      .array(SupportRouteRemoval)
      .describe("This environment's own inbound routing rules: one per address its composition claims."),
  })
  .describe("What `pithy support deprovision` removed.");

const provision = withContract(
  defineCommand({
    meta: {
      name: "provision",
      description:
        "Create the support bucket, deploy the classification workers, and route each environment's inbound address",
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
          "Override: the Cloudflare Zone ID of the zone that contains the address's domain. For a subdomain (help.example.com) that is the parent zone (example.com), where Email Routing for the subdomain is set up. Email Routing must already be enabled for the domain. With --inbound-address and --app-worker, it replaces the routes derived from each environment's inboundAddresses with one rule.",
      },
      "inbound-address": {
        type: "string",
        description:
          "Override: the exact recipient address the rule matches (e.g. support@help.example.com). It must also be listed in support()'s inboundAddresses, which is what claims it. Pass it with --routing-zone and --app-worker.",
      },
      "app-worker": {
        type: "string",
        description:
          "Override: the deployed name of the app worker the rule delivers to, the one running createEntrypoint with support composed (e.g. acme-prod-api). Pass it with --routing-zone and --inbound-address.",
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
        // The project's own environment set: what this command fans out across, rather than a
        // pair the CLI assumed. A project declaring `live` gets `live` provisioned and torn down too.
        const environments = loadProjectEnvironments(config);
        const { provisionSupport } = await loadSupport(projectDir);
        const { account, accountId, apiToken } = commandCredentials(await projectCloudflareAccount(projectDir));
        // One resolution for the config and the app database the classification hosts are deployed against:
        // that Worker's own support capability, never a sibling's.
        const { isSupportCapability } = await loadSupport(projectDir);
        const { worker: appWorker, capability } = await resolveCapabilityWorker({
          projectDir,
          ...(args.worker !== undefined ? { worker: args.worker } : {}),
          name: "support",
          is: isSupportCapability,
        });
        const supportConfig = capability.supportConfig;
        // A Worker that owns what the support host binds gets a host of its own.
        const owner = provisionHostOwner(capability, appWorker.target);
        const routing = resolveRouting(args["routing-zone"], args["inbound-address"], args["app-worker"]);
        // Which environments this run can act on, decided once and before the bucket exists. An environment
        // whose app database is not provisioned yet is skipped and reported, never fatal.
        const readiness = await environmentReadiness({
          workerDir: appWorker.dir,
          label: `${appWorker.name}'s wrangler.jsonc`,
          environments,
          productionEnvironments: config.seed?.productionEnvironments,
        });
        const provisioner = new CloudflareSupportProvisioner({
          cf: await cloudflareClients({ accountId, apiToken }),
          projectDir,
          project,
          account,
          apiToken,
          supportConfig,
          resolveEnv: buildResolveEnv(readiness),
          ...(owner ? { owner } : {}),
          ...(routing !== undefined
            ? { routing }
            : {
                environmentRouting: await Promise.all(
                  readiness.ready.map((env) =>
                    environmentRouting({
                      projectDir,
                      project,
                      env,
                      worker: workerDirName(appWorker),
                      isSupportCapability,
                    }),
                  ),
                ),
              }),
          audit: await buildAudit(projectDir, accountId, apiToken, args.worker),
          workflows: await cloudflareWorkflows({ accountId, apiToken }),
        });

        // The ready list, not the declaration. The bucket is project-global and is created whatever else skips; a
        // skipped environment never reaches `deployWorker`, and has no route.
        const result = await provisionSupport(provisioner, readiness.ready);
        const search = new Map(result.search.map((entry) => [entry.env, entry]));
        // The app Worker binds the message index too — the search route embeds a query and asks it — and an
        // index's `index_name` is a provisioning output, so the entry is written here, complete, or removed when
        // the index was dropped: a binding to a deleted index fails the next deploy.
        const semantic = new Map((result.semantic ?? []).map((entry) => [entry.env, entry]));
        await recordSemanticBindings(appWorker.dir, supportConfig, result.semantic ?? []);

        // The caller's own run, as the refusal names it to run again: every flag it was given, and the Worker it
        // resolved when none was named.
        const again = rerunRemedy(callerOf("support provision", args), {
          flags: { "--worker": workerDirName(appWorker) },
          productionEnvironments: readiness.productionEnvironments,
        });
        // What the run did before any environment could refuse it: the bucket is project-global and is created
        // whatever else skipped. A refusal that left a bucket this run made out would say nothing happened. One an
        // earlier run made is not this run's doing, and is not claimed.
        const did = result.bucket.created
          ? [`It created the project's support bucket (${result.bucket.bucket}), which every environment shares.`]
          : [];
        if (args.json) {
          // One outcome: the error line alone when nothing was provisioned, or this report alone.
          writeProvisionReport(
            {
              command: "support provision",
              ...result,
              inboundRoutes: provisioner.routes,
              skippedEnvironments: readiness.skipped,
            },
            readiness,
            again,
            did,
          );
          return;
        }
        process.stdout.write(
          result.bucket.skipped
            ? "Attachments are off. No bucket created.\n"
            : `Bucket ${result.bucket.bucket} ready.\n`,
        );
        // One line per declared environment, so a skip reads as a skip. An aggregate count cannot answer
        // "did production get its classification worker", which is the only question this report is for.
        process.stdout.write(
          formatEnvironmentOutcomes(
            environmentOutcomes(readiness, (env) => {
              const entry = search.get(env);
              // Three outcomes, not two. A repair is a database this run **changed** — its table was
              // there and its triggers were not — and reading that as "already matches" is what would
              // leave an operator with no reason to look at why messages stopped being indexed.
              const index = entry?.created
                ? ", search index created"
                : entry?.dropped
                  ? ", search index dropped"
                  : entry?.repaired
                    ? ", search index triggers restored and backfilled"
                    : "";
              return `classification worker deployed${index}${messageIndexOutcome(semantic.get(env))}`;
            }),
          ),
        );
        requireReadyEnvironments(readiness, again, did);
        // Say what happened to the index. It is DDL on the adopter's app database, and a provisioning
        // command that silently creates or drops a table is one an operator cannot audit by reading its
        // output. The per-environment lines above carry a create or a drop; silence there means it already
        // matched the config, which is also worth saying out loud.
        if (result.search.every((entry) => !entry.created && !entry.dropped && !entry.repaired)) {
          process.stdout.write("Search index already matches your config.\n");
        }
        // One line per rule, and a refusal said as plainly as a route. Everything else can be right and the inbox
        // still receive nothing, so these are the lines an operator needs to read.
        for (const route of provisioner.routes) process.stdout.write(`${routeLine(route)}\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: SupportProvisionPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
    flagGroups: [
      {
        kind: "allOrNone",
        flags: ["--routing-zone", "--inbound-address", "--app-worker"],
        rule: "The routing override is --routing-zone, --inbound-address and --app-worker together, or none of them.",
      },
    ],
  },
);

const deprovision = withContract(
  defineCommand({
    meta: {
      name: "deprovision",
      description:
        "Remove one environment's classification worker and its inbound routing rule (and, with the last, the bucket)",
    },
    args: {
      json: { type: "boolean", default: false, description: "Machine-readable output" },
      // No default: a bare `deprovision` removed every declared environment's classification worker,
      // production's included.
      env: TEARDOWN_ENV_ARG,
      worker: {
        type: "string",
        description: "The app worker whose wrangler.jsonc names the database the audit trail is written to",
      },
      storage: {
        type: "boolean",
        default: false,
        description:
          "Also delete the R2 bucket with every attachment and raw message in it (irreversible — this is your support history). Every environment shares it, so only the last environment's teardown may",
      },
      "routing-zone": {
        type: "string",
        description:
          "Cloudflare Zone ID of the project-global rule that provision's --routing-zone, --inbound-address and --app-worker created. Without it that rule is left in place. Every environment shares it, so only the last environment's teardown may remove it. This environment's own rule is removed either way.",
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
        // One named environment, settled before any credential is read: naming nothing, or something
        // undeclared, costs nothing and lists what could be named. The kit's teardown resolves it again — it
        // is the one that deletes.
        const declared = loadProjectEnvironments(config);
        const env = requireTeardownEnvironment(args.env, declared);
        const { deprovisionSupport, isSupportCapability } = await loadSupport(projectDir);
        const { account, accountId, apiToken, r2Raw } = commandCredentials(await projectCloudflareAccount(projectDir));
        // Resolve the key pair up front, before a single worker comes down. A bucket cannot be deleted
        // without it, so discovering it is missing at the bucket step would leave the workers gone and the
        // bucket standing — a half-torn-down inbox for a mistake we can catch here.
        const r2Credentials = args.storage
          ? resolveR2Credentials(args["r2-access-key-id"], args["r2-secret-access-key"], r2Raw)
          : undefined;
        const cf = await cloudflareClients({ accountId, apiToken });
        const audit = await buildAudit(projectDir, accountId, apiToken, args.worker);
        const deprovisioner = new CloudflareSupportDeprovisioner({
          owners: await projectHostOwners(projectDir),
          account,
          cf,
          workflows: await cloudflareWorkflows({ accountId, apiToken }),
          projectDir,
          project,
          ...(args["routing-zone"] !== undefined ? { routingZoneId: args["routing-zone"] } : {}),
          ...(r2Credentials !== undefined ? { r2Credentials } : {}),
          audit,
        });

        // The limits are held here, not by the orchestrator. It is the project's installed copy, and an older one may
        // remove the routing rule first and ask nothing after. So what every environment shares is refused before
        // that copy is called, and it may delete only what was typed, for `env` alone.
        const confined = await confineTeardown({
          kit: "@pithy-sh/support",
          target: env,
          declared,
          runs: (other) => deprovisioner.hasWorker(other),
          deprovisioner,
          rules: {
            hasWorker: "read",
            deleteWorkflows: "environment",
            deleteWorker: "environment",
            deleteBucket: args.storage ? { what: "the support bucket", flag: "--storage" } : "refused",
            removeRoutingRule:
              args["routing-zone"] !== undefined
                ? { what: "the inbound routing rule", flag: "--routing-zone" }
                : "refused",
          },
        });
        // This environment's own rules go first, once nothing is left to refuse: new mail stops arriving before the
        // worker that would have handled it is removed.
        const routes = await removeEnvironmentRoutes({
          cf,
          account,
          routing: await environmentRouting({ projectDir, project, env, worker: args.worker, isSupportCapability }),
          audit,
        });
        await deprovisionSupport(
          confined,
          { environment: env, declared },
          { deleteStorage: args.storage, removeRouting: args["routing-zone"] !== undefined },
        );

        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({
              command: "support deprovision",
              env,
              storageDeleted: args.storage,
              routingZone: args["routing-zone"] ?? null,
              inboundRoutes: routes,
            })}\n`,
          );
          return;
        }
        process.stdout.write(
          `${env}: classification worker removed${args.storage ? ", with the bucket and everything in it" : ""}.\n`,
        );
        for (const removal of routes) process.stdout.write(`${removalLine(removal)}\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: SupportDeprovisionPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

export default defineCommand({
  meta: { name: "support", description: "Provision and manage the support inbox infrastructure" },
  subCommands: { provision, deprovision },
});
