// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { defineCommand } from "citty";
import { type CliAuditEmit, createCliAudit } from "../audit/cliAudit";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { loadProject, loadProjectCloudflare, loadProjectEnvironments, requireProjectName } from "../project/config";
import { requireManagedEnvironment } from "../project/environment";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { assertProvisionConfirmed, provisionConfirmPhrase } from "../provision/confirm";
import { provisionEnvironment } from "../provision/environment";
import { AUDIT_DESTINATION_ENV, cloudflareProvisioners, type ResourceProvisioners } from "../provision/resources";
import { secretsStoreBindings, workerSecretRegistry } from "../provision/secretBindings";
import { cloudflareSecretsStore, type SecretsStore } from "../provision/store";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy provision --env <name>` — **the lifecycle step that was specified for feature environments and
 * never written for the ones a project ships to.**
 *
 * Before this, a project scaffolded, wired and migrated by pithy could not be deployed: `add` runs the
 * Worker's *dev* migrations, `migrate --env prod` assumes the database exists, and `deploy` provisions
 * nothing. The only remote creators were capability-owned or `pithy feature provision`, which does
 * exactly the right thing for the wrong environment set. So the deliverable was the step, not a patch —
 * `pithy provision` is `pithy feature provision`'s work under the naming a declared environment wants.
 *
 * **It is its own command, and `deploy` refuses rather than calling it.** A deploy that silently creates
 * account resources is hard to review, and these are the long-lived ones — the ids land in a checked-in
 * `wrangler.jsonc` and belong under a human's eye in a pull request. `pithy deploy --env staging` names
 * this command instead of failing inside wrangler.
 *
 * **There is no `pithy deprovision`.** `feature destroy` reverses a branch's environment because a
 * branch's environment is disposable. Staging and production are not, and the one-word difference
 * between the two is not a difference a flag should carry. Deleting them is deliberate, by hand, in
 * Cloudflare.
 */

/** Build the CF control-plane provisioners from the environment's credentials, or null when they are absent. */
function buildProvisioners(account: CloudflareAccountSelection | null): ResourceProvisioners | null {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return null;
  return cloudflareProvisioners(new CloudflareClients({ accountId, apiToken }));
}

/**
 * The account's Secrets Store, or `null` when this project has recorded no store id.
 *
 * Absent is a degraded environment, never a failed command: a project composing no `secrets` capability
 * needs no store, and one that does gets its `secrets_store_secrets` stanza — the binding `pithy add`
 * deliberately could not write, and nothing came back for (#238).
 */
function buildStore(account: CloudflareAccountSelection | null): SecretsStore | null {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  const storeId = vars.SECRETS_STORE_ID ?? "";
  if (!accountId || !apiToken || !storeId) return null;
  return cloudflareSecretsStore(new CloudflareClients({ accountId, apiToken }), storeId);
}

/**
 * The audit emitter. Provisioning creates real infrastructure under a real token, and it runs headlessly
 * in CI, so every creation leaves a record of what was made and under whose credentials.
 *
 * The trail lands in the project's own top-level database — the environment being provisioned may not
 * have one yet, which is the whole point of the command.
 */
async function buildAudit(
  projectDir: string,
  capabilities: Capability[],
  account: CloudflareAccountSelection | null,
): Promise<CliAuditEmit> {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  return createCliAudit({
    projectDir,
    // Routing, not truth: each event names the environment it acted on. Claiming this as `actedOn`
    // would blame `dev` for a change to production — the regression `auditDestination.test.ts` pins.
    env: AUDIT_DESTINATION_ENV,
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/** The interactive confirm prompt for a production environment. Names what is about to happen first. */
function confirmPrompt(env: string): () => Promise<string> {
  return async () => {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({
      message: `This creates Cloudflare resources in ${env}. Type "${provisionConfirmPhrase(env)}" to confirm:`,
    });
    return isCancel(answer) ? "" : answer;
  };
}

export default defineCommand({
  meta: {
    name: "provision",
    description: "Create an environment's own Cloudflare resources, wire them into each Worker, then migrate",
  },
  args: {
    env: { type: "string", required: true, description: "The declared environment to provision" },
    yes: { type: "boolean", default: false, description: "Confirm that this creates real Cloudflare resources" },
    confirm: {
      type: "string",
      description: 'Unlock a production environment non-interactively: "yes, i really want to provision <env>"',
    },
    seed: { type: "boolean", default: false, description: "Also load seed fixtures once the schema is up" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const config = await loadProject(projectDir);
      // The declaration decides what may be provisioned. `--env live` on a project that never declared
      // `live` is refused here, naming the set it does have — rather than creating `<project>-live-db`
      // that nothing else in the CLI would ever look for again.
      const env = requireManagedEnvironment(args.env, loadProjectEnvironments(config));
      const interactive = !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
      await assertProvisionConfirmed({
        env,
        yes: args.yes,
        json: args.json,
        ...(args.confirm !== undefined ? { confirmPhrase: args.confirm } : {}),
        ...(interactive ? { prompt: confirmPrompt(env) } : {}),
        ...(config.seed?.productionEnvironments !== undefined
          ? { productionEnvironments: config.seed.productionEnvironments }
          : {}),
      });

      const account = loadProjectCloudflare(config) ?? null;
      const provisioners = buildProvisioners(account);
      if (!provisioners) {
        throw new ValidationError({
          message: "Cloudflare credentials are missing.",
          action: `Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to provision ${env}.`,
        });
      }

      const capabilities = projectCapabilities(await resolveWorkers({ projectDir }));
      // The scope carries both the names and the stanza. There is no second argument to disagree with.
      const scope = environmentScope(requireProjectName(config), env);
      const store = buildStore(account);
      const report = await provisionEnvironment({
        projectDir,
        scope,
        capabilities,
        provisioners,
        ...(store
          ? {
              secretBindings: async (workerCapabilities) =>
                secretsStoreBindings({
                  // A Worker composing no secrets capability declares no secrets, and gets no stanza.
                  registry: workerSecretRegistry(workerCapabilities) ?? {},
                  scope,
                  storeId: store.storeId,
                  exists: (name) => store.exists(name),
                }),
            }
          : {}),
        // Off unless asked. A declared environment already holds real rows; seeding one is `pithy seed`'s
        // job, with its own gate, and it must not be something provisioning did on the way past.
        seedData: args.seed,
        audit: await buildAudit(projectDir, capabilities, account),
      });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "provision", ...report })}\n`);
        return;
      }
      for (const resource of report.resources) {
        process.stdout.write(`${resource.name}: ${resource.created ? "created" : "exists"}.\n`);
      }
      for (const worker of report.workers) {
        process.stdout.write(`${worker.worker} deploys as ${worker.name}.\n`);
      }
      for (const service of report.services) {
        process.stdout.write(`${service.binding} bound to ${service.service}.\n`);
      }
      for (const secret of report.secretBindings) {
        process.stdout.write(
          secret.bound
            ? `${secret.binding} reads ${secret.entry}.\n`
            : `${secret.binding} has no store entry yet. Create it with pithy secrets create ${secret.binding}.\n`,
        );
      }
      process.stdout.write(`Provisioned ${report.env}. Migrated.\n`);
      process.stdout.write(`${formatDone()}\n`);
    }),
});
