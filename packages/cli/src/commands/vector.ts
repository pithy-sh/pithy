// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { parse } from "comment-json";
import { createRemoteCliAudit } from "../audit/cliAudit";
import { CloudflareVectorProvisioner, loadVector, type VectorModule } from "../capabilities/vectorProvisioner";
import { type AppVectorizeBinding, applyAppBindings, appWorkflowBindings } from "../project/appBindings";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { assertResetConfirmed, resetConfirmPhrase } from "../seed/safety";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy vector provision | reset | reprocess` — the three commands that stand a search index up, rebuild
 * it, and re-embed it.
 *
 * All three are `--env`-targeted, and `dev` is a real environment here rather than a local one: Cloudflare
 * ships no local emulation for Vectorize, so a dev search reaches a real remote index. That is also why the
 * capability's bindings are declared `remote`.
 *
 * `reset` carries the reset gate from `docs/CLI.md` §7.5 — the same gate `pithy seed --redo` uses, imported
 * rather than re-implemented. `--yes` does not unlock it: `--yes` means "yes, this is not dev", and it was
 * designed to authorize additive writes. A reset deletes every vector in an index.
 */

/** The Cloudflare credentials every vector command needs, from `.dev.vars` then `process.env`. */
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

/** Load the vector capability's resolved config from `pithy.config.ts`. */
async function loadVectorConfig(projectDir: string) {
  const { isVectorCapability } = await loadVector();
  // Capabilities live in each Worker's `apps/<name>/pithy.config.ts`; provisioning is one
  // project-wide decision, so the first Worker composing this capability provides it.
  const capability = (await resolveWorkers({ projectDir }).then(projectCapabilities)).find(isVectorCapability);
  if (!capability) {
    throw new ValidationError({
      message: "The vector capability is not configured.",
      action: "Add `vector({ indexes: { ... } })` to pithy.config.ts (run `pithy add vector`).",
    });
  }
  return capability.vectorConfig;
}

/** The `wrangler.jsonc` slice the app database id is read from. */
interface WranglerAppConfig {
  d1_databases?: { binding: string; database_id?: string }[];
  env?: Record<string, { d1_databases?: { binding: string; database_id?: string }[] } | undefined>;
}

/**
 * Resolve the app database id for an environment. `dev` reads the top-level bindings; every other
 * environment reads its own `env.<name>` stanza — the same rule the audit target resolver uses.
 */
function buildResolveEnv(projectDir: string): (env: string) => Promise<{ appDatabaseId: string }> {
  return async (env) => {
    const config = parse(await readFile(join(projectDir, "wrangler.jsonc"), "utf8")) as unknown as WranglerAppConfig;
    const stanza = env === "dev" ? config : config.env?.[env];
    const appDatabaseId = stanza?.d1_databases?.find((database) => database.binding === "DB")?.database_id;
    if (!appDatabaseId) {
      throw new ValidationError({
        message: `wrangler.jsonc has no DB database_id for ${env}.`,
        action: `Provision the ${env} app database and set its id on the DB binding — the corpus lives there.`,
      });
    }
    return { appDatabaseId };
  };
}

/** Build the live provisioner for one environment. */
async function buildProvisioner(projectDir: string, env: string) {
  const { accountId, apiToken } = loadCloudflareCreds(projectDir);
  const config = await loadVectorConfig(projectDir);
  return {
    config,
    env,
    provisioner: new CloudflareVectorProvisioner({
      cf: new CloudflareClients({ accountId, apiToken }),
      accountId,
      apiToken,
      config,
      resolveEnv: buildResolveEnv(projectDir),
      workflows: new CloudflareWorkflowsClient({ accountId, apiToken }),
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
 */
async function recordProvisioned(
  projectDir: string,
  env: string,
  result: Awaited<ReturnType<VectorModule["provisionVector"]>>,
): Promise<void> {
  const { toProvisionRecord, VECTOR_PROVISIONED_VAR } = await loadVector();
  const value = JSON.stringify(toProvisionRecord(result));

  const config = (await readWranglerConfig(projectDir)) as WranglerVarsConfig;
  if (env === "dev") {
    config.vars ??= {};
    config.vars[VECTOR_PROVISIONED_VAR] = value;
  } else {
    config.env ??= {};
    config.env[env] ??= {};
    const stanza = config.env[env];
    if (stanza) {
      stanza.vars ??= {};
      stanza.vars[VECTOR_PROVISIONED_VAR] = value;
    }
  }
  await writeWranglerConfig(projectDir, config);
}

/**
 * Write this environment's `vectorize` and `workflows` bindings into the app's `wrangler.jsonc`.
 *
 * `pithy add vector` cannot write either one: wrangler requires an `index_name` on a `vectorize` entry
 * and a `name` + `class_name` on a `workflows` entry, and both values are provisioning outputs. So the
 * entries arrive here, complete, once the index exists and the reprocess worker is deployed —
 * `capabilities/add.ts` documents the other half of the contract.
 */
async function recordBindings(
  projectDir: string,
  env: string,
  config: Awaited<ReturnType<typeof loadVectorConfig>>,
  result: Awaited<ReturnType<VectorModule["provisionVector"]>>,
): Promise<void> {
  const { vectorWorkflowRegistry, VECTOR_CAPABILITY } = await loadVector();
  const vectorize: AppVectorizeBinding[] = result.indexes.flatMap((entry) => {
    const binding = config.indexes[entry.index]?.binding;
    // Vectorize has no local emulation, so the binding reaches the real index even in `wrangler dev`.
    return binding ? [{ binding, index_name: entry.indexName, remote: true }] : [];
  });

  await applyAppBindings(projectDir, env, {
    vectorize,
    workflows: appWorkflowBindings(vectorWorkflowRegistry, VECTOR_CAPABILITY, env),
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

const provision = defineCommand({
  meta: {
    name: "provision",
    description: "Create each configured index and its metadata indexes, then deploy the reprocess worker",
  },
  args: {
    env: { type: "string", default: "dev", description: "Target environment" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { provisionVector } = await loadVector();
      const { provisioner, config } = await buildProvisioner(projectDir, args.env);

      const result = await provisionVector(provisioner, { config, env: args.env });
      // Last, and only on success: the record is the Worker's evidence that these metadata indexes exist,
      // so it must never claim more than provisioning actually got done.
      await recordProvisioned(projectDir, args.env, result);
      await recordBindings(projectDir, args.env, config, result);

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
});

const reset = defineCommand({
  meta: {
    name: "reset",
    description: "DESTRUCTIVE: delete each index, rebuild it, and re-embed the corpus from D1",
  },
  args: {
    env: { type: "string", default: "dev", description: "Target environment" },
    "confirm-reset": {
      type: "string",
      description: 'Unlock a non-dev reset non-interactively: "yes, i really want to reset <env>"',
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const interactive = !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

      // The gate first, before a single Cloudflare call. `--yes` deliberately does not appear here.
      await assertResetConfirmed({
        env: args.env,
        json: args.json,
        ...(args["confirm-reset"] !== undefined ? { confirmReset: args["confirm-reset"] } : {}),
        ...(interactive ? { prompt: resetPrompt(args.env) } : {}),
      });

      const { resetVector } = await loadVector();
      const { provisioner, config, accountId, apiToken } = await buildProvisioner(projectDir, args.env);

      // A reset destroys an environment's entire search index, so it is audited at `critical` — and on `dev`
      // it is audited not at all, because a dev reset changes nothing shared.
      const audit = await createRemoteCliAudit({
        projectDir,
        env: args.env,
        capabilities: await resolveWorkers({ projectDir }).then(projectCapabilities),
        clients: new CloudflareClients({ accountId, apiToken }),
        apiToken,
      });
      const event = {
        action: "vector/index_reset" as const,
        severity: "critical" as const,
        resourceType: "cf_vectorize_index" as const,
        resourceId: args.env,
        metadata: { indexes: Object.keys(config.indexes) },
      };

      let result: Awaited<ReturnType<typeof resetVector>>;
      try {
        result = await resetVector(provisioner, { config, env: args.env });
      } catch (error) {
        // Truthful: recorded as it happened, never as it was intended.
        await audit({ ...event, outcome: "failure" });
        throw error;
      }
      await audit({ ...event, outcome: "success" });
      // A reset rebuilds every index, so the record it left behind is stale by definition. Rewrite it.
      await recordProvisioned(projectDir, args.env, result);

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "vector reset", ...result })}\n`);
        return;
      }
      process.stdout.write(`DESTRUCTIVE. Every vector in ${args.env} was deleted and rebuilt from the corpus.\n`);
      for (const entry of result.indexes) {
        process.stdout.write(`${entry.index}: ${entry.indexName} rebuilt and re-embedded.\n`);
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const reprocess = defineCommand({
  meta: { name: "reprocess", description: "Re-embed an index's documents through the reprocess Workflow" },
  args: {
    env: { type: "string", default: "dev", description: "Target environment" },
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
      const projectDir = process.cwd();
      const { provisioner, config } = await buildProvisioner(projectDir, args.env);
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
          report: await provisioner.reprocess(args.env, index, {
            all: args.all,
            ...(filter ? { filter } : {}),
          }),
        });
      }

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "vector reprocess", env: args.env, runs })}\n`);
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
});

/** The interactive reset prompt: an `@clack/prompts` text field asking for the exact, environment-named phrase. */
function resetPrompt(env: string): () => Promise<string> {
  return async () => {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({
      message: `DESTRUCTIVE: this deletes every vector in ${env}. Type "${resetConfirmPhrase(env)}" to confirm:`,
    });
    return isCancel(answer) ? "" : answer;
  };
}

export default defineCommand({
  meta: { name: "vector", description: "Provision, reset, and re-embed the vector indexes" },
  subCommands: { provision, reset, reprocess },
});
