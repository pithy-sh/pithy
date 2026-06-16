import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { WorkflowSecretDispatcher } from "@pithy-sh/secrets/src/manager/dispatcher";
import { deprovisionSecrets, provisionSecrets } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { resolveSecretRegistry, runSecretWrite } from "../capabilities/secrets";
import {
  buildManagerDeploy,
  CloudflareSecretsDeprovisioner,
  CloudflareSecretsProvisioner,
} from "../capabilities/secretsProvisioner";
import { loadProject } from "../project/config";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";

/** The write-Workflow name for an environment — matches the manager's `wrangler.jsonc` + provisioning. */
function workflowNameForEnv(env: ManagedEnvironment): string {
  return `pithy-secrets-write-${env}`;
}

/** Build the live dispatcher from CF creds (`.dev.vars`, then `process.env`). */
function buildDispatcher(projectDir: string): SecretDispatcher {
  const { accountId, apiToken } = loadCloudflareCreds(projectDir);
  return new WorkflowSecretDispatcher(new CloudflareWorkflowsClient({ accountId, apiToken }), workflowNameForEnv);
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
  if (requested) return ManagedEnvironment.parse(requested);
  const entry = registry[name];
  if (entry && entry.scope === "environment") {
    throw new ValidationError({
      message: `Secret '${name}' is environment-scoped — choose an environment.`,
      action: "Pass --env staging or --env production.",
    });
  }
  // A global write reaches both environments regardless; the requested env is unused.
  return "production";
}

/** Shared body for create/update/rm: discover the registry, dispatch, and report the envs written. */
async function write(
  mode: "create" | "update" | "delete",
  args: { name: string; env?: string; json: boolean },
): Promise<void> {
  const projectDir = process.cwd();
  const registry = resolveSecretRegistry(await loadProject(projectDir));
  const env = resolveEnv(registry, args.name, args.env);
  const value = mode === "delete" ? undefined : await readValue(args.name);
  const dispatcher = buildDispatcher(projectDir);

  const targets = await runSecretWrite(registry, dispatcher, { mode, name: args.name, value, env });

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
  env: { type: "string", description: "Target environment for an environment-scoped secret: staging | production" },
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
      const registry = resolveSecretRegistry(await loadProject(process.cwd()));
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
      const cf = new CloudflareClients({ accountId, apiToken });
      const provisioner = new CloudflareSecretsProvisioner({
        cf,
        accountId,
        storeId,
        deploy: buildManagerDeploy({ accountId, apiToken }),
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
      const deprovisioner = new CloudflareSecretsDeprovisioner({ cf, storeId });

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
