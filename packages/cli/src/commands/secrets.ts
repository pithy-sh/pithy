// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS, type DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import type { SecretDispatcher, SecretProbe } from "@pithy-sh/secrets/src/cli/dispatch";
import { deprovisionSecrets, provisionSecrets } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { canonicalGlobalEnvironment, type ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { createCliAudit } from "../audit/cliAudit";
import { mintDeclaredSecrets, storeSecretMinter } from "../capabilities/mintSecrets";
import { resolveSecretRegistry, runSecretWrite } from "../capabilities/secrets";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import {
  buildManagerDeploy,
  CloudflareSecretsDeprovisioner,
  CloudflareSecretsProvisioner,
} from "../capabilities/secretsProvisioner";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { editDevSecrets } from "../devSecrets/edit";
import { resolveDevSecretsFile } from "../devSecrets/location";
import { loadProject, projectCloudflareAccount, projectEnvironments, requireProjectName } from "../project/config";
import { requireManagedEnvironment } from "../project/environment";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { secretsStoreBindings, workerSecretRegistry } from "../provision/secretBindings";
import { cloudflareSecretsStore } from "../provision/store";
import { applySecretBindings } from "../provision/wranglerEnv";
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
  const vars = cloudflareEnv({ account: await projectCloudflareAccount(projectDir) });
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
async function buildDispatcher(projectDir: string): Promise<SecretDispatcher & SecretProbe> {
  const { accountId, apiToken } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
  const project = requireProjectName(await loadProject(projectDir));
  return buildSecretDispatcher(accountId, apiToken, project);
}

/** The CF credentials and Secrets Store id provisioning needs, from `.dev.vars` then `process.env`. */
function loadCloudflareCreds(
  account: CloudflareAccountSelection | null,
  options: { requireStore?: boolean } = {},
): {
  accountId: string;
  apiToken: string;
  storeId: string;
} {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  const storeId = vars.SECRETS_STORE_ID ?? "";
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: "Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.",
    });
  }
  if (options.requireStore && !storeId) {
    throw new ValidationError({
      message: "The CF Secrets Store id is missing.",
      action: "Run pithy add secrets to record SECRETS_STORE_ID (create a Secrets Store in the Cloudflare dashboard).",
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
function resolveEnv(
  registry: SecretRegistry,
  name: string,
  requested: string | undefined,
  declared: DeclaredEnvironments,
): ManagedEnvironment {
  if (requested) return requireManagedEnvironment(requested, declared);
  const entry = registry[name];
  if (entry && entry.scope === "environment") {
    throw new ValidationError({
      message: `Secret '${name}' is environment-scoped — choose an environment.`,
      action: `Pass one of ${declared.map((env) => `--env ${env}`).join(" or ")}.`,
    });
  }
  // A global write reaches every declared environment regardless; the requested env is unused. The
  // canonical one is named here rather than the literal `prod`, which a project without one does not have.
  return canonicalGlobalEnvironment(declared) ?? declared[0] ?? "prod";
}

/** Shared body for create/update/rm: discover the registry, dispatch, and report the envs written. */
async function write(
  mode: "create" | "update" | "delete",
  args: { name: string; env?: string; json: boolean },
): Promise<void> {
  const projectDir = process.cwd();
  const registry = await projectSecretRegistry(projectDir);
  const environments = await projectEnvironments(projectDir);
  const env = resolveEnv(registry, args.name, args.env, environments);
  const value = mode === "delete" ? undefined : await readValue(args.name);
  const dispatcher = await buildDispatcher(projectDir);
  const audit = await buildAudit(projectDir, env);

  const targets = await runSecretWrite(
    registry,
    dispatcher,
    { mode, name: args.name, value, env, environments },
    audit,
  );

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
    // Resolved when the command tree is built, before any project is read, so this names the default set
    // and the refusal names the project's own — see `requireManagedEnvironment`.
    description: `Target environment for an environment-scoped secret: ${DEFAULT_ENVIRONMENTS.join(" | ")}, or one declared in pithy.config.ts`,
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
          // A keyspace is marked, because it is the one entry an operator must not try to set: its
          // members are written per key by the application that mints them.
          description: `${entry.backend} · ${entry.scope}${entry.rotatable ? " · rotatable" : ""}${entry.keyed ? " · keyspace" : ""}`,
        }));
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "secrets ls", secrets: rows })}\n`);
        return;
      }
      process.stdout.write(`${formatList(rows)}\n`);
    }),
});

/**
 * `pithy secrets edit` — the local dev values, in the adopter's editor (#157).
 *
 * The odd one out in this file, and deliberately: every other subcommand here writes a **managed**
 * secret through the manager Workflow, and this one touches nothing but the machine-local file at
 * `<config>/<project>/secrets.jsonc`. They are siblings because they are the same question — "where does
 * this value live" — asked about the two environments a project has.
 *
 * It resolves the path, opens it, validates what comes back, and writes it atomically at `0600`. It
 * prints a path and a count, and never a name or a value: `secrets ls` is what lists names.
 */
const edit = defineCommand({
  meta: { name: "edit", description: "Edit this machine's dev secret values in your editor" },
  args: { json: { type: "boolean", default: false, description: "Machine-readable output" } },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      // The one resolution of where the file is (`devSecrets/location.ts`). It requires a project name
      // rather than guessing one: a guess would open one checkout's secrets from another's worktree.
      const path = await resolveDevSecretsFile(process.cwd());
      const result = await editDevSecrets({ path });

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({ command: "secrets edit", path, changed: result.changed, secrets: result.secrets })}\n`,
        );
        return;
      }
      process.stdout.write(
        result.changed
          ? `${path} written. ${result.secrets} ${result.secrets === 1 ? "secret" : "secrets"}.\n`
          : `${path} unchanged.\n`,
      );
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const provision = defineCommand({
  meta: { name: "provision", description: "Provision the per-environment secrets infrastructure" },
  args: { json: { type: "boolean", default: false, description: "Machine-readable output" } },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { accountId, apiToken, storeId } = loadCloudflareCreds(await projectCloudflareAccount(projectDir), {
        requireStore: true,
      });
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

      const environments = await projectEnvironments(projectDir);
      const result = await provisionSecrets(provisioner, environments);

      // **The step the deferral was deferring to (#238).** `pithy add` cannot write a `secret` binding —
      // the entry needs a `store_id` and a `secret_name` that do not exist until an account has been
      // reached — and `ensureSecretsStoreId` records nothing in five cases besides. Provisioning is when
      // the store certainly exists and every entry has certainly been written, so this is where the
      // adopter's own Workers get the stanza. It corrects an existing entry rather than duplicating it,
      // and leaves a binding this registry does not declare exactly where the adopter put it.
      //
      // `dev` is deliberately not among them: local dev materialises every `cf-secrets-store` secret into
      // the generated `.dev.vars` (#179), so a stanza there would name entries a local run never reads.
      const store = cloudflareSecretsStore(cf, storeId);
      // One emitter per environment, resolved once: `buildAudit` reaches the account and the Worker set,
      // and it is the same answer for every Worker in a given environment.
      const audits = new Map(
        await Promise.all(environments.map(async (env) => [env, await buildAudit(projectDir, env)] as const)),
      );
      const wired: { worker: string; env: string; bindings: string[]; created: string[] }[] = [];
      for (const worker of await resolveWorkers({ projectDir })) {
        const registry = workerSecretRegistry(worker.capabilities);
        if (!registry) continue;
        for (const env of environments) {
          const { bound, minted } = await secretsStoreBindings({
            registry,
            scope: environmentScope(project, env),
            storeId,
            exists: (name) => store.exists(name),
            // Every environment's master key exists by now, so this is the point where a declared
            // mintable secret can be created and bound in one pass rather than named as homework (#321).
            mint: storeSecretMinter({
              store,
              environment: env,
              ...(audits.get(env) ? { audit: audits.get(env) } : {}),
            }),
          });
          if (bound.length === 0) continue;
          await applySecretBindings(worker.dir, env, bound);
          wired.push({ worker: worker.name, env, bindings: bound.map((entry) => entry.binding), created: minted });
        }
      }

      // **The other half of #321, and the half its own commit message describes.** The loop above creates
      // the `cf-secrets-store` secrets a Worker binds; every secret the *kit* declares arbitrary — the
      // auth session secret, the email link-signing key — is `d1`, and until now provisioning finished by
      // telling an operator to go and generate random bytes for each. This is the point where it can stop
      // doing that: `provisionSecrets` above has deployed each environment's manager, and the manager is
      // the only thing that can decide whether one of these already exists, because its value is sealed
      // under a master key the CLI never holds. So the managers are **asked** first, across every
      // environment at once, and only then written to. See `capabilities/mintSecrets.ts`.
      //
      // One audit emitter is picked rather than one per environment: this loop spans every environment
      // a `global` secret reaches, and the event's own `environments` field is what says where a value
      // went. `dev` is the same fallback `buildAudit` above uses for a command with no single target.
      const managers = await buildDispatcher(projectDir);
      const generated = await mintDeclaredSecrets({
        registry: await projectSecretRegistry(projectDir),
        dispatcher: managers,
        probe: managers,
        environments,
        audit: await buildAudit(projectDir, "dev"),
      });

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({ command: "secrets provision", environments: result.perEnv, wired, generated })}\n`,
        );
        return;
      }
      for (const env of result.perEnv) {
        process.stdout.write(`${env.env}: database, key, and manager ready.\n`);
      }
      for (const entry of wired) {
        process.stdout.write(`${entry.worker} env.${entry.env} binds ${entry.bindings.join(", ")}.\n`);
        if (entry.created.length > 0) {
          process.stdout.write(`${entry.env}: created ${entry.created.join(", ")}.\n`);
        }
      }
      // It used to say only "ready", because the manager decided whether a value was written and never
      // reported back. It reports now, so the run can say the thing an operator actually needs to know:
      // whether this run generated a production signing key, or found one already there.
      for (const secret of generated) {
        process.stdout.write(
          secret.created.length > 0
            ? `${secret.name} created in ${secret.created.join(", ")}.\n`
            : `${secret.name} already in ${secret.environments.join(", ")}.\n`,
        );
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
      const { accountId, apiToken, storeId } = loadCloudflareCreds(await projectCloudflareAccount(projectDir), {
        requireStore: true,
      });
      const cf = new CloudflareClients({ accountId, apiToken });
      const deprovisioner = new CloudflareSecretsDeprovisioner({
        cf,
        project: requireProjectName(await loadProject(projectDir)),
        storeId,
        audit: await buildAudit(projectDir, "dev"),
      });

      await deprovisionSecrets(deprovisioner, await projectEnvironments(projectDir), { deleteKeys: args.keys });

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
  subCommands: { create, update, rm, ls, edit, provision, deprovision },
});
