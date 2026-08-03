// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { deprovisionSecrets, provisionSecrets } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { type ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { createCliAudit } from "../audit/cliAudit";
import { resolveSecretRegistry, runSecretWrite } from "../capabilities/secrets";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import {
  buildManagerDeploy,
  CloudflareSecretsDeprovisioner,
  CloudflareSecretsProvisioner,
} from "../capabilities/secretsProvisioner";
import { loadProject, requireProjectName } from "../project/config";
import { requireManagedEnvironment } from "../project/environment";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";

/**
 * The secret registry for the whole project: every Worker's, merged by secret name.
 *
 * Capabilities are per Worker, so the registry is too. The secret **name** is the join key — the same name
 * resolves the same value through any registry that declares it — so `pithy secrets` must see every declared
 * name, not just the alphabetically-first Worker's. A Worker that does not compose `secrets` simply
 * contributes nothing; when no Worker does, the capability's own actionable error is what surfaces.
 */
async function projectSecretRegistry(projectDir: string): Promise<SecretRegistry> {
  const workers = await resolveWorkers({ projectDir });
  const registries: SecretRegistry[] = [];
  let absent: unknown;
  for (const worker of workers) {
    try {
      registries.push(resolveSecretRegistry(worker.config));
    } catch (error) {
      absent = error;
    }
  }
  const first = registries[0];
  if (!first) throw absent;
  return registries.length === 1 ? first : (Object.assign({}, ...registries) as SecretRegistry);
}

/**
 * The audit emitter for a secrets command. Every value-touching write is a warning-severity event
 * (CLAUDE.md §Security), so this is built for every write and provisioning call — a no-op when
 * Cloudflare credentials or the audit capability aren't there, never a blocker.
 */
async function buildAudit(projectDir: string, env: string) {
  const vars = loadCloudflareEnv(projectDir);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  // Auditing spans the project, not one Worker: `audit` composed anywhere means the trail exists.
  const capabilities = await resolveWorkers({ projectDir })
    .then(projectCapabilities)
    .catch(() => []);
  return createCliAudit({
    projectDir,
    env,
    // Here `env` really is the environment acted on, so it is also the recorded origin.
    actedOn: env,
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/**
 * Build the live dispatcher from CF creds (`.dev.vars`, then `process.env`) and the project name.
 *
 * `requireProjectName`, never `resolveProjectName`: the target Workflow is `<project>-<env>-secrets-write`
 * and Workflow names are account-scoped, so a fallback-derived name would either dispatch nowhere or
 * dispatch this project's values into another project's manager.
 */
async function buildDispatcher(projectDir: string): Promise<SecretDispatcher> {
  const { accountId, apiToken } = loadCloudflareCreds(projectDir);
  const project = requireProjectName(await loadProject(projectDir));
  return buildSecretDispatcher(accountId, apiToken, project);
}

/** The CF credentials and Secrets Store id provisioning needs, from `.dev.vars` then `process.env`. */
function loadCloudflareCreds(
  projectDir: string,
  options: { requireStore?: boolean } = {},
): { accountId: string; apiToken: string; storeId: string } {
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
  if (options.requireStore && !storeId) {
    throw new ValidationError({
      message: "The CF Secrets Store id is missing.",
      action: "Set SECRETS_STORE_ID in .dev.vars (create a Secrets Store in the Cloudflare dashboard).",
    });
  }
  return { accountId, apiToken, storeId };
}

/**
 * Read the secret value: from stdin when it is piped (agent/non-interactive use), otherwise from a
 * masked prompt. Never from a flag — a value there would persist in shell history and process lists.
 */
async function readValue(name: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
  }
  const { isCancel, password } = await import("@clack/prompts");
  const answer = await password({ message: `Value for '${name}'` });
  if (isCancel(answer)) {
    process.stderr.write("Cancelled.\n");
    process.exit(1);
  }
  return answer;
}

/** Resolve the target env for a write: required for an environment-scoped secret, ignored for a global one. */
function resolveEnv(registry: SecretRegistry, name: string, requested: string | undefined): ManagedEnvironment {
  if (requested) return requireManagedEnvironment(requested);
  const entry = registry[name];
  if (entry && entry.scope === "environment") {
    throw new ValidationError({
      message: `Secret '${name}' is environment-scoped — choose an environment.`,
      action: "Pass --env staging or --env prod.",
    });
  }
  // A global write reaches both environments regardless; the requested env is unused.
  return "prod";
}

/** Shared body for create/update/rm: discover the registry, dispatch, and report the envs written. */
async function write(
  mode: "create" | "update" | "delete",
  args: { name: string; env?: string; json: boolean },
): Promise<void> {
  const projectDir = process.cwd();
  const registry = await projectSecretRegistry(projectDir);
  const env = resolveEnv(registry, args.name, args.env);
  const value = mode === "delete" ? undefined : await readValue(args.name);
  const dispatcher = await buildDispatcher(projectDir);
  const audit = await buildAudit(projectDir, env);

  const targets = await runSecretWrite(registry, dispatcher, { mode, name: args.name, value, env }, audit);

  if (args.json) {
    process.stdout.write(`${formatJsonLine({ command: `secrets ${mode}`, name: args.name, environments: targets })}\n`);
    return;
  }
  process.stdout.write(`${args.name} ${mode === "delete" ? "removed from" : "written to"} ${targets.join(", ")}.\n`);
  process.stdout.write(`${formatDone()}\n`);
}

const nameArg = {
  name: { type: "positional", required: true, description: "Secret name (a registry entry)." },
} as const;
const sharedArgs = {
  env: {
    type: "string",
    description: `Target environment for an environment-scoped secret: ${managedEnvironments().join(" | ")}`,
  },
  json: { type: "boolean", default: false, description: "Machine-readable output" },
} as const;

const create = defineCommand({
  meta: { name: "create", description: "Create a secret (fails if it already exists)" },
  args: { ...nameArg, ...sharedArgs },
  run: ({ args }) => withErrorReporting(args.json, () => write("create", args)),
});

const update = defineCommand({
  meta: { name: "update", description: "Update a secret (fails if it doesn't exist)" },
  args: { ...nameArg, ...sharedArgs },
  run: ({ args }) => withErrorReporting(args.json, () => write("update", args)),
});

const rm = defineCommand({
  meta: { name: "rm", description: "Remove a secret" },
  args: { ...nameArg, ...sharedArgs },
  run: ({ args }) => withErrorReporting(args.json, () => write("delete", args)),
});

const ls = defineCommand({
  meta: { name: "ls", description: "List the declared secrets" },
  args: { json: { type: "boolean", default: false, description: "Machine-readable output" } },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const registry = await projectSecretRegistry(process.cwd());
      const rows = Object.entries(registry)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => ({
          name,
          description: `${entry.backend} · ${entry.scope}${entry.rotatable ? " · rotatable" : ""}`,
        }));
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "secrets ls", secrets: rows })}\n`);
        return;
      }
      process.stdout.write(`${formatList(rows)}\n`);
    }),
});

const provision = defineCommand({
  meta: { name: "provision", description: "Provision the per-environment secrets infrastructure" },
  args: { json: { type: "boolean", default: false, description: "Machine-readable output" } },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { accountId, apiToken, storeId } = loadCloudflareCreds(projectDir, { requireStore: true });
      // Never `resolveProjectName`: every Secrets Store entry and the manager's token name derive from
      // this, and deprovision has to recompute them exactly. A guessed name would name resources
      // teardown can never find again.
      const project = requireProjectName(await loadProject(projectDir));
      const cf = new CloudflareClients({ accountId, apiToken });
      // Provisioning spans every managed environment, not one — "dev" is the fallback the audit
      // database resolves against when a command has no single target env (mirrors `pithy feature`).
      const provisioner = new CloudflareSecretsProvisioner({
        cf,
        accountId,
        project,
        storeId,
        deploy: buildManagerDeploy({ accountId, apiToken, project }),
        audit: await buildAudit(projectDir, "dev"),
      });

      const result = await provisionSecrets(provisioner);

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "secrets provision", environments: result.perEnv })}\n`);
        return;
      }
      for (const env of result.perEnv) {
        process.stdout.write(`${env.env}: database, key, and manager ready.\n`);
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const deprovision = defineCommand({
  meta: { name: "deprovision", description: "Remove the secrets manager workers and databases" },
  args: {
    keys: { type: "boolean", default: false, description: "Also delete the master keys (irreversible)" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { accountId, apiToken, storeId } = loadCloudflareCreds(projectDir, { requireStore: true });
      const cf = new CloudflareClients({ accountId, apiToken });
      const deprovisioner = new CloudflareSecretsDeprovisioner({
        cf,
        project: requireProjectName(await loadProject(projectDir)),
        storeId,
        audit: await buildAudit(projectDir, "dev"),
      });

      await deprovisionSecrets(deprovisioner, { deleteKeys: args.keys });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "secrets deprovision", keysDeleted: args.keys })}\n`);
        return;
      }
      process.stdout.write(`Secrets infrastructure removed${args.keys ? ", including master keys" : ""}.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});

export default defineCommand({
  meta: { name: "secrets", description: "Manage encrypted secrets" },
  subCommands: { create, update, rm, ls, provision, deprovision },
});
