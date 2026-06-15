import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { WorkflowSecretDispatcher } from "@pithy-sh/secrets/src/manager/dispatcher";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { resolveSecretRegistry, runSecretWrite } from "../capabilities/secrets";
import { loadProject } from "../project/config";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";

/** The write-Workflow name for an environment — matches the manager's `wrangler.jsonc` + provisioning. */
function workflowNameForEnv(env: ManagedEnvironment): string {
  return `pithy-secrets-write-${env}`;
}

/** Parse `.dev.vars` from the project for the CF creds the dispatcher needs. */
async function loadDevVars(projectDir: string): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(join(projectDir, ".dev.vars"), "utf8");
  } catch {
    return {};
  }
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return vars;
}

/** Build the live dispatcher from CF creds (`.dev.vars`, then `process.env`). */
async function buildDispatcher(projectDir: string): Promise<SecretDispatcher> {
  const vars = await loadDevVars(projectDir);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CF_API_TOKEN ?? process.env.CF_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: "Set CLOUDFLARE_ACCOUNT_ID and CF_API_TOKEN in .dev.vars.",
    });
  }
  return new WorkflowSecretDispatcher(new CloudflareWorkflowsClient({ accountId, apiToken }), workflowNameForEnv);
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
  const dispatcher = await buildDispatcher(projectDir);

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

export default defineCommand({
  meta: { name: "secrets", description: "Manage encrypted secrets" },
  subCommands: { create, update, rm, ls },
});
