// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PreconditionFailedError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { defineCommand } from "citty";
import { z } from "zod";
import { createRemoteCliAudit } from "../audit/cliAudit";
import { CloudflareVectorProvisioner, loadVector, type VectorModule } from "../capabilities/vectorProvisioner";
import { cloudflareClients, cloudflareWorkflows } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { withContract } from "../contract/commandContract";
import { type AppVectorizeBinding, applyAppBindings, appWorkflowBindings } from "../project/appBindings";
import { resolveCapabilityWorker } from "../project/capabilityWorker";
import { loadProject, projectCloudflareAccount, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment } from "../project/environment";
import { projectCapabilities, type ResolvedWorker, resolveWorkers } from "../project/workerScope";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { stanzaFor } from "../project/wranglerInheritance";
import { withProvisionFix } from "../provision/provisionFix";
import { assertResetConfirmed, resetConfirmPhrase } from "../seed/safety";
import { canceled } from "../terminal/exitClass";
import { mayPrompt } from "../terminal/inputMode";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy vector provision | reset | reprocess` — the three commands that stand a search index up, rebuild
 * it, and re-embed it.
 *
 * All three are `--env`-targeted, and `dev` is a real environment here rather than a local one: Cloudflare
 * ships no local emulation for Vectorize, so a dev search reaches a real remote index. That is also why the
 * capability's bindings are declared `remote`.
 *
 * `reset` carries the reset gate from `docs/commands/seed.md` — the same gate `pithy seed --redo` uses, imported
 * rather than re-implemented. `--yes` does not unlock it: `--yes` means "yes, this is not dev", and it was
 * designed to authorize additive writes. A reset deletes every vector in an index.
 */

/**
 * The Cloudflare credentials this command provisions with, for **the account the project belongs to**.
 *
 * The account is a parameter rather than an ambient, so this cannot resolve before something has
 * established which account the project is for (#206).
 */
function loadCloudflareCreds(account: CloudflareAccountSelection | null): { accountId: string; apiToken: string } {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    throw new PreconditionFailedError({
      message: "Cloudflare credentials are missing.",
      action: "Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.",
    });
  }
  return { accountId, apiToken };
}

/** The `wrangler.jsonc` slice the app database id is read from. */
interface WranglerAppConfig {
  d1_databases?: { binding: string; database_id?: string }[];
  env?: Record<string, { d1_databases?: { binding: string; database_id?: string }[] } | undefined>;
}

/**
 * Resolve the app database id for an environment, from **the app Worker's** `wrangler.jsonc`. `dev` reads
 * the top-level bindings; every other environment reads its own `env.<name>` stanza — the same rule the
 * audit target resolver uses.
 *
 * Which file, and why it is the Worker's: every deployable Worker lives in `apps/<name>/` with its own
 * config and **there is no root Worker** (CLAUDE.md §CLI). This read was `join(projectDir, "wrangler.jsonc")`
 * — one of three root-file reads in a command that had no root file to read — so `pithy vector` was
 * unusable in every scaffolded project, and it died on a raw `ENOENT` stack rather than on a `PithyError`
 * naming the remedy. `readWranglerConfig` is what supplies the refusal (#512).
 *
 * `vector` stays outside {@link environmentReadiness}'s skip-and-report set deliberately: every subcommand
 * here takes a required `--env`, so nothing about it fans out and a refusal has exactly one environment to
 * be about. The routing correction applies; the skip does not.
 *
 * **A plain function, called once from {@link buildProvisioner}, and no longer a closure the provisioner
 * calls when it gets around to it.** As a closure this was invoked from `deployWorker` — the *last* step of
 * provisioning — so the refusal `docs/commands/vector.md` describes as happening "rather than standing up an
 * index with nothing to fill it" fired after the index and every one of its metadata indexes had been
 * created, and on `reset --env prod` after the production index had already been deleted and rebuilt. An
 * operator who confirms a reset has confirmed a reset, not a reset that dies halfway and leaves the index
 * rebuilt and unfillable. Reading it up front makes the documented order the implemented one (#512).
 */
async function requireAppDatabaseId(
  appWorker: ResolvedWorker,
  env: string,
  productionEnvironments: readonly string[] | undefined,
): Promise<{ appDatabaseId: string }> {
  const config = (await readWranglerConfig(appWorker.dir)) as WranglerAppConfig;
  const stanza = env === LOCAL_ENVIRONMENT ? config : config.env?.[env];
  const appDatabaseId = stanza?.d1_databases?.find((database) => database.binding === "DB")?.database_id;
  if (appDatabaseId) return { appDatabaseId };
  const refusal = new PreconditionFailedError({
    message: `${appWorker.name}'s wrangler.jsonc has no DB database_id for ${env}.`,
    action: `Provision the ${env} app database and set its id on the DB binding — the corpus lives there.`,
  });
  // `pithy provision` refuses `dev`, so a `dev` refusal names no command: the only one it could name fails.
  // Nor does production, whose provisioning needs a person's `--confirm` phrase (`withProvisionFix`).
  if (env === LOCAL_ENVIRONMENT) throw refusal;
  throw withProvisionFix(refusal, env, productionEnvironments);
}

/**
 * Build the live provisioner for one environment, and resolve the project name every one of these
 * commands needs. An index is *found by name and reused*, so the name must be the same on every run:
 * `requireProjectName` refuses to guess where `resolveProjectName` would differ between checkouts.
 *
 * The app Worker is resolved here, once, and every file this command reads or writes is reached through
 * it — the database id, the `VECTOR_PROVISIONED` record, and the `vectorize`/`workflows` bindings all live
 * in one `apps/<name>/wrangler.jsonc`. `--worker` names it in a project holding several; a project with one
 * needs no ceremony.
 *
 * **This is the preflight, and it is the preflight for all three subcommands** — every one of them builds a
 * provisioner before it makes a single Cloudflare call, so everything that can decide the run cannot proceed
 * is decided here: the project name, the credentials, the capability's config, the Worker, and the app
 * database this environment's corpus lives in. Nothing below this line is local, and nothing above it
 * creates or destroys anything.
 *
 * `reprocess` is gated on the database id too, though it deploys nothing. It is not a new restriction: an
 * environment can only have a reprocess Workflow to dispatch because a provision run deployed one, and that
 * run required the id. So the gate refuses exactly the environments where the dispatch would have failed
 * anyway, and it refuses them by naming the Worker and the remedy instead of by way of a Cloudflare 404.
 */
async function buildProvisioner(projectDir: string, env: string, worker: string | undefined) {
  // The name first, before the credentials: both are local checks, and a config that cannot name the
  // project is not a Cloudflare problem to report as one.
  const projectConfig = await loadProject(projectDir);
  const project = requireProjectName(projectConfig);
  const productionEnvironments = projectConfig.seed?.productionEnvironments;
  const { accountId, apiToken } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
  // One resolution for the config and every write: the indexes provisioned are the ones the Worker they are
  // recorded in declares (#590 review). They used to come from the first Worker composing vector.
  const { isVectorCapability } = await loadVector(projectDir);
  const { worker: appWorker, capability } = await resolveCapabilityWorker({
    projectDir,
    ...(worker !== undefined ? { worker } : {}),
    name: "vector",
    is: isVectorCapability,
  });
  const config = capability.vectorConfig;
  // Read now, not when `deployWorker` asks for it. The provisioner's `resolveEnv` seam stays — it is what
  // keeps the wrangler parsing out of the provisioner — but it now serves an answer this command already
  // has, so the refusal cannot arrive after the work.
  const readiness = await requireAppDatabaseId(appWorker, env, productionEnvironments);
  return {
    project,
    config,
    env,
    appWorker,
    provisioner: new CloudflareVectorProvisioner({
      cf: await cloudflareClients({ accountId, apiToken }),
      projectDir,
      project,
      accountId,
      apiToken,
      config,
      resolveEnv: async (requested) =>
        requested === env ? readiness : requireAppDatabaseId(appWorker, requested, productionEnvironments),
      workflows: await cloudflareWorkflows({ accountId, apiToken }),
    }),
    accountId,
    apiToken,
  };
}

/** The `wrangler.jsonc` slice the provisioning record is written into. */
interface WranglerVarsConfig {
  vars?: Record<string, string>;
  env?: Record<string, { vars?: Record<string, string> } | undefined>;
}

/**
 * Write what provisioning observed into the app's `wrangler.jsonc`, as the `VECTOR_PROVISIONED` var for this
 * environment. The Worker compares its declared filterable fields against it at boot and refuses to serve on
 * drift — which is the only way an adopter who edits a metadata schema and deploys without re-provisioning
 * hears about it, because Vectorize answers such a filter with partial results and no error.
 *
 * `dev` writes the top-level `vars`; every other environment writes its own `env.<name>` stanza — the same
 * rule the app database id is read by, above. The write is comment-preserving and idempotent: re-running
 * provision with nothing changed rewrites the identical string.
 *
 * Into the app Worker's own `wrangler.jsonc` — the file the Worker deploys from, and the same one readiness
 * was read from. Written at the project root it landed in a file nothing loads, so the drift guard this
 * record exists to feed never saw a value at all (#512).
 */
async function recordProvisioned(
  projectDir: string,
  workerDir: string,
  env: string,
  result: Awaited<ReturnType<VectorModule["provisionVector"]>>,
): Promise<void> {
  const { toProvisionRecord, VECTOR_PROVISIONED_VAR } = await loadVector(projectDir);
  const value = JSON.stringify(toProvisionRecord(result));

  const config = (await readWranglerConfig(workerDir)) as WranglerVarsConfig;
  // The one reader (#581). `dev` comes back as the top level, and an `env.<name>` it creates carries what
  // an environment does not inherit — so the drift record never lands in a stanza that holds it alone.
  const stanza = stanzaFor(config, env) as { vars?: Record<string, string> };
  stanza.vars ??= {};
  stanza.vars[VECTOR_PROVISIONED_VAR] = value;
  await writeWranglerConfig(workerDir, config);
}

/**
 * Write this environment's `vectorize` and `workflows` bindings into the app's `wrangler.jsonc`.
 *
 * `pithy add vector` cannot write either one: wrangler requires an `index_name` on a `vectorize` entry
 * and a `name` + `class_name` on a `workflows` entry, and both values are provisioning outputs. So the
 * entries arrive here, complete, once the index exists and the reprocess worker is deployed —
 * `capabilities/add.ts` documents the other half of the contract.
 *
 * Into the app Worker's `wrangler.jsonc`, for the reason above: a binding written to the project root is a
 * binding the deployed Worker never gets.
 */
async function recordBindings(
  projectDir: string,
  workerDir: string,
  project: string,
  env: string,
  config: Awaited<ReturnType<typeof buildProvisioner>>["config"],
  result: Awaited<ReturnType<VectorModule["provisionVector"]>>,
): Promise<void> {
  const { vectorWorkflowRegistry, VECTOR_CAPABILITY } = await loadVector(projectDir);
  const vectorize: AppVectorizeBinding[] = result.indexes.flatMap((entry) => {
    const binding = config.indexes[entry.index]?.binding;
    // Vectorize has no local emulation, so the binding reaches the real index even in `wrangler dev`.
    return binding ? [{ binding, index_name: entry.indexName, remote: true }] : [];
  });

  await applyAppBindings(workerDir, env, {
    vectorize,
    workflows: appWorkflowBindings(vectorWorkflowRegistry, { project, capability: VECTOR_CAPABILITY, env }),
  });
}

/** Parse a `--filter` argument. A malformed filter fails here rather than inside a running Workflow. */
function parseFilter(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new ValidationError({
      message: "--filter is not valid JSON.",
      action: 'Pass a metadata filter object, e.g. --filter \'{"ownerId":"ada"}\'.',
    });
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new ValidationError({
      message: "--filter must be a JSON object.",
      action: 'Pass a metadata filter object, e.g. --filter \'{"ownerId":"ada"}\'.',
    });
  }
  return decoded as Record<string, unknown>;
}

const MetadataIndexes = (what: string) =>
  z
    .array(
      z
        .object({
          propertyName: z.string().describe("The metadata property the index covers."),
          indexType: z.string().describe("How Vectorize stores the values: `string`, `number` or `boolean`."),
        })
        .describe("One metadata index."),
    )
    .describe(what);

/** One index as `provision` and `reset` report it. */
const VectorIndex = z
  .object({
    index: z.string().describe("The config's name for the index."),
    indexName: z.string().describe("The Vectorize index name it was provisioned as."),
    created: MetadataIndexes("The metadata indexes created on this run. Empty on a re-run."),
    extra: MetadataIndexes("Metadata indexes that exist and the config does not declare."),
    observed: MetadataIndexes("Every metadata index live on the index when provisioning finished."),
  })
  .describe("One configured index.");

/** `pithy vector provision --json`. `docs/commands/vector.md`. */
const VectorProvisionPayload = z
  .object({
    command: z.literal("vector provision").describe('`"vector provision"`.'),
    env: z.string().describe("The environment provisioned."),
    indexes: z.array(VectorIndex).describe("One entry per configured index."),
  })
  .describe("What `pithy vector provision` provisioned.");

/** `pithy vector reset --json`. */
const VectorResetPayload = z
  .object({
    command: z.literal("vector reset").describe('`"vector reset"`.'),
    env: z.string().describe("The environment reset."),
    indexes: z.array(VectorIndex).describe("Each rebuilt index."),
    deleted: z.array(z.string().describe("A Vectorize index name.")).describe("The indexes deleted and rebuilt."),
    reprocessed: z.array(z.string().describe("An index's config name.")).describe("The reprocess runs started."),
  })
  .describe("What `pithy vector reset` rebuilt.");

/** `pithy vector reprocess --json`. */
const VectorReprocessPayload = z
  .object({
    command: z.literal("vector reprocess").describe('`"vector reprocess"`.'),
    env: z.string().describe("The environment the runs happened in."),
    runs: z
      .array(
        z
          .object({
            index: z.string().describe("The config's name for the index."),
            report: z
              .unknown()
              .optional()
              .describe("The Workflow's own return value, passed through verbatim. Absent when it returned nothing."),
          })
          .describe("One reprocess run."),
      )
      .describe("One entry per index reprocessed, in run order."),
  })
  .describe("What `pithy vector reprocess` ran.");

const provision = withContract(
  defineCommand({
    meta: {
      name: "provision",
      description: "Create each configured index and its metadata indexes, then deploy the reprocess worker",
    },
    args: {
      env: ENV_ARG,
      worker: {
        type: "string",
        description:
          "The app worker whose wrangler.jsonc carries the per-environment DB binding and receives the vectorize bindings (default: the project's only worker)",
      },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const env = requireEnvironment(args.env);
        const projectDir = process.cwd();
        const { provisionVector } = await loadVector(projectDir);
        const { provisioner, project, config, appWorker } = await buildProvisioner(projectDir, env, args.worker);

        const result = await provisionVector(provisioner, { project, config, env });
        // Last, and only on success: the record is the Worker's evidence that these metadata indexes exist,
        // so it must never claim more than provisioning actually got done.
        await recordProvisioned(projectDir, appWorker.dir, env, result);
        await recordBindings(projectDir, appWorker.dir, project, env, config, result);

        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "vector provision", ...result })}\n`);
          return;
        }
        for (const entry of result.indexes) {
          const created = entry.created.length > 0 ? `, ${entry.created.length} metadata index(es) created` : "";
          process.stdout.write(`${entry.index}: ${entry.indexName} ready${created}.\n`);
          for (const extra of entry.extra) {
            process.stdout.write(`  ${extra.propertyName} is indexed but not declared. It still costs a slot.\n`);
          }
        }
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: VectorProvisionPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

const reset = withContract(
  defineCommand({
    meta: {
      name: "reset",
      description: "DESTRUCTIVE: delete each index, rebuild it, and re-embed the corpus from D1",
    },
    args: {
      env: ENV_ARG,
      worker: {
        type: "string",
        description:
          "The app worker whose wrangler.jsonc carries the per-environment DB binding (default: the project's only worker)",
      },
      "confirm-reset": {
        type: "string",
        description: 'Unlock a non-dev reset non-interactively: "yes, i really want to reset <env>"',
      },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const env = requireEnvironment(args.env);
        const projectDir = process.cwd();
        const interactive = mayPrompt(args.json);

        // The gate first, before a single Cloudflare call. `--yes` deliberately does not appear here.
        await assertResetConfirmed({
          env,
          json: args.json,
          ...(args["confirm-reset"] !== undefined ? { confirmReset: args["confirm-reset"] } : {}),
          ...(interactive ? { prompt: resetPrompt(env) } : {}),
        });

        const { resetVector } = await loadVector(projectDir);
        const { provisioner, project, config, appWorker, accountId, apiToken } = await buildProvisioner(
          projectDir,
          env,
          args.worker,
        );

        // A reset destroys an environment's entire search index, so it is audited at `critical` — and on `dev`
        // it is audited not at all, because a dev reset changes nothing shared.
        const audit = await createRemoteCliAudit({
          projectDir,
          env,
          capabilities: await resolveWorkers({ projectDir }).then(projectCapabilities),
          clients: await cloudflareClients({ accountId, apiToken }),
          apiToken,
        });
        const event = {
          action: "vector/index_reset" as const,
          severity: "critical" as const,
          resourceType: "cf_vectorize_index" as const,
          resourceId: env,
          metadata: { indexes: Object.keys(config.indexes) },
        };

        let result: Awaited<ReturnType<typeof resetVector>>;
        try {
          result = await resetVector(provisioner, { project, config, env });
        } catch (error) {
          // Truthful: recorded as it happened, never as it was intended.
          await audit({ ...event, outcome: "failure" });
          throw error;
        }
        await audit({ ...event, outcome: "success" });
        // A reset rebuilds every index, so the record it left behind is stale by definition. Rewrite it.
        await recordProvisioned(projectDir, appWorker.dir, env, result);

        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "vector reset", ...result })}\n`);
          return;
        }
        process.stdout.write(`DESTRUCTIVE. Every vector in ${env} was deleted and rebuilt from the corpus.\n`);
        for (const entry of result.indexes) {
          process.stdout.write(`${entry.index}: ${entry.indexName} rebuilt and re-embedded.\n`);
        }
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: VectorResetPayload,
    mutates: true,
    idempotent: false,
    needsNetwork: true,
  },
);

const reprocess = withContract(
  defineCommand({
    meta: { name: "reprocess", description: "Re-embed an index's documents through the reprocess Workflow" },
    args: {
      env: ENV_ARG,
      worker: {
        type: "string",
        description:
          "The app worker whose wrangler.jsonc carries the per-environment DB binding (default: the project's only worker)",
      },
      index: { type: "string", description: "The index to re-embed, as named in pithy.config.ts" },
      all: {
        type: "boolean",
        default: false,
        description: "Re-embed every document, not only the ones whose model differs from config",
      },
      filter: { type: "string", description: 'Narrow the run to matching documents, as JSON: \'{"ownerId":"ada"}\'' },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const env = requireEnvironment(args.env);
        const projectDir = process.cwd();
        const { provisioner, config } = await buildProvisioner(projectDir, env, args.worker);
        const filter = parseFilter(args.filter);

        // No `--index` means every configured index, which is what "re-embed after a model change" usually is.
        const indexes = args.index ? [args.index] : Object.keys(config.indexes);
        for (const index of indexes) {
          if (!config.indexes[index]) {
            throw new ValidationError({
              message: `No index named \`${index}\` is configured.`,
              action: `Pick one of: ${Object.keys(config.indexes).join(", ")}.`,
            });
          }
        }

        const runs: { index: string; report: unknown }[] = [];
        for (const index of indexes) {
          runs.push({
            index,
            report: await provisioner.reprocess(env, index, {
              all: args.all,
              ...(filter ? { filter } : {}),
            }),
          });
        }

        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "vector reprocess", env, runs })}\n`);
          return;
        }
        for (const run of runs) {
          const report = run.report as { reembedded?: number; scanned?: number } | null;
          process.stdout.write(
            `${run.index}: ${report?.reembedded ?? 0} re-embedded of ${report?.scanned ?? 0} scanned.\n`,
          );
        }
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: VectorReprocessPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

/** The interactive reset prompt: an `@clack/prompts` text field asking for the exact, environment-named phrase. */
export function resetPrompt(env: string): () => Promise<string> {
  return async () => {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({
      message: `DESTRUCTIVE: this deletes every vector in ${env}. Type "${resetConfirmPhrase(env)}" to confirm:`,
    });
    if (isCancel(answer)) canceled();
    return answer;
  };
}

export default defineCommand({
  meta: { name: "vector", description: "Provision, reset, and re-embed the vector indexes" },
  subCommands: { provision, reset, reprocess },
});
