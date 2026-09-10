// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { defineCommand } from "citty";
import { createProjectCliAudit } from "../audit/cliAudit";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { readProjectLedger } from "../migrations/run";
import { loadProject, projectCloudflareAccount, requireProjectName } from "../project/config";
import { deployProject, deployVerificationFailed, pendingWarning, summarizeDeploy } from "../project/deploy";
import {
  deployKitWorkers,
  type KitDeployReport,
  kitDeployFailed,
  summarizeKitDeploy,
  summarizeKitProblem,
} from "../project/deployKit";
import { assertOriginsDeclared } from "../project/domains";
import { optionalEnvArg, requireEnvironment } from "../project/environment";
import { assertWorkflowsBound } from "../project/workflows";
import { assertEnvironmentProvisioned } from "../provision/unprovisioned";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * How many migrations are unapplied for the target env — best-effort, never blocking. Deploy and
 * migrate are orthogonal (deploy never migrates), so a config that can't load or a database it can't
 * reach yields `undefined` (no warning) rather than failing the deploy.
 *
 * Deploy ships every Worker, so the count does too — it fans out over `apps/*` exactly as `pithy migrate`
 * would. The warning is about the project's schema being behind, and a table any Worker owns is one this
 * deploy's code may read.
 *
 * **Best-effort is not unattributed.** The count reaches a remote D1 for any `--env`, so it takes the
 * same account the deploy beside it does. Omitting it resolved `<config>/cloudflare.json` while the
 * deploy resolved the project's named account — one command, one run, two tenants, and a number about
 * somebody else's schema printed as though it were this project's (#206, #226).
 */
async function pendingFor(
  projectDir: string,
  env: string,
  account: CloudflareAccountSelection | null,
): Promise<number | undefined> {
  try {
    // Only the pending half here. A drifted ledger is a fault `pithy doctor` names and `pithy migrate`
    // refuses on, and deploy never migrates — it reports how far the schema is behind, which stays a
    // truthful number either way.
    const ledger = await readProjectLedger({ projectDir, env, account });
    // A partial read still warns, and the number it warns with is the one it established (#371). A sum
    // over the databases that answered can only understate how far behind the project is, so it never
    // raises a false alarm — and this line is warn-only. Which database went unread is `pithy doctor`'s
    // sentence to say, in the report whose job is naming faults.
    if (ledger.state === "partial") return ledger.counted.pending;
    return ledger.state === "read" ? ledger.pending : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The audit emitter for `pithy deploy`. Shipping code to an environment is exactly the kind of action
 * an audit trail exists for, so every worker deploy — success or failure — is recorded when the project
 * has audit wired. A bare `pithy deploy` (no `--env`) still targets the project's own app database, the
 * same one `dev` reads (see `resolveAuditDatabaseId`), so the fallback lines up with the real target.
 */
async function buildAudit(projectDir: string, env: string, account: CloudflareAccountSelection | null) {
  const vars = cloudflareEnv({ account });
  // `audit` composed by any Worker means the project has a trail; deploy spans them all. Here `env` really
  // is the environment acted on, so it is also the recorded origin.
  return createProjectCliAudit({
    projectDir,
    accountId: vars.CLOUDFLARE_ACCOUNT_ID,
    apiToken: vars.CLOUDFLARE_API_TOKEN,
    env,
    actedOn: env,
  });
}

/**
 * **Which halves of the project this run ships.**
 *
 * No selector means both, because a deploy is a deploy: the project's Workers are the ones under
 * `apps/` *and* one per composed capability that owns Workflows. Naming one narrows to it; naming
 * both is the same as naming neither, spelled out.
 *
 * The two are separate steps rather than one list, and that is what CI wanted: separate exit codes,
 * separate logs, and a failure that says which half broke.
 */
export function deploySelection(args: { apps: boolean; kit: boolean }): { apps: boolean; kit: boolean } {
  if (!args.apps && !args.kit) return { apps: true, kit: true };
  return { apps: args.apps, kit: args.kit };
}

/**
 * Refuse the flag combinations that could only ever be misunderstandings.
 *
 * **`--apps --force`.** The adopter's Workers are never gated — their code is the thing that changed,
 * and the CLI cannot see a bundle — so `--force` has nothing to override there. Accepting it silently
 * is how a flag comes to mean nothing.
 *
 * **`--kit`, or `--force`, with no `--env`.** A kit Worker is deployed per environment, always: its
 * configuration is stamped into its vars, so `<project>-staging-email` and `<project>-prod-email` are
 * genuinely separate Workers and there is no top-level stanza to fall back on. A bare `pithy deploy`
 * still runs — it ships `apps/` and says the kit half needed an environment — because that is the
 * command's old behavior and it must keep working. Asking for the kit half by name and getting silence
 * is the thing that must not.
 *
 * **`--kit`, or `--force`, with `--env dev`.** There is no deployed kit Worker in `dev`: it runs
 * locally under `pithy dev`, and `pithy <capability> provision` fans out over the managed environments
 * only. So a run narrowed to the kit half in `dev` has nothing whatever to do, and `--force` has no
 * deploy to force. `pithy deploy --env dev` itself still runs — it ships `apps/` and says the kit's
 * Workers are local, the same trade the bare deploy makes.
 *
 * **Every one of these is asked of {@link deploySelection}, not of the raw flags.** `--apps --kit` is
 * the same selection as naming neither, and it was the one combination that disagreed with its own
 * documentation: it threw `--kit needs an environment.` where a bare `pithy deploy` succeeded.
 */
export function assertDeployFlags(args: { apps: boolean; kit: boolean; force: boolean; env?: string }): void {
  const selection = deploySelection(args);
  if (args.force && !selection.kit) {
    throw new ValidationError({
      message: "--force has nothing to do with --apps.",
      action: "Drop --force, or drop --apps: only the kit's Workers are gated.",
      detail: "Workers under apps/ are deployed unconditionally, so there is no stamp for --force to override.",
    });
  }
  // Narrowed *to* the kit half — which `--apps --kit` is not, because naming both narrows nothing.
  const kitOnly = selection.kit && !selection.apps;
  const flag = kitOnly ? "--kit" : args.force ? "--force" : undefined;
  if (flag === undefined) return;
  if (args.env === undefined) {
    throw new ValidationError({
      message: `${flag} needs an environment.`,
      action: "Add --env staging or --env prod.",
      detail: "A kit Worker's configuration is stamped into its vars at deploy time, so it is per environment.",
    });
  }
  if (args.env === LOCAL_ENVIRONMENT) {
    throw new ValidationError({
      message: `${flag} has nothing to deploy in dev.`,
      action: "Run pithy dev to run the kit's Workers locally, or pass --env staging or --env prod.",
      detail: "A kit Worker in dev is materialized under .wrangler/pithy/hosts and run by pithy dev, never deployed.",
    });
  }
}

/** The line a bare `pithy deploy` prints instead of deploying kit Workers it has no environment for. */
const NO_ENV_FOR_KIT =
  "No --env, so the kit's Workers were not deployed. They are per environment — pass --env to ship them.";

/**
 * The line `pithy deploy --env dev` prints in its place.
 *
 * **Not a failure, and not silence.** `dev` is the local environment: a capability's Worker is
 * materialized under `.wrangler/pithy/hosts/` and run by `pithy dev`, there is no deployed
 * `<project>-dev-email` for a stamp to gate, and `resolveWorkerAddress` answers `null` for `dev`
 * because a local run has no public address. Left to the kit half, every host was skipped for having
 * no `dev` address and an all-skipped run failed the command — so `pithy deploy --env dev` exited 1
 * every time, while `--env dev` was documented and offered by this command's own action lines.
 */
const KIT_IS_LOCAL_IN_DEV = "In dev the kit's Workers run locally under pithy dev, so none were deployed.";

export default defineCommand({
  meta: { name: "deploy", description: "Deploy to Cloudflare Workers" },
  args: {
    env: optionalEnvArg("Target environment (omit for each worker's top-level config)"),
    apps: { type: "boolean", default: false, description: "Deploy only the Workers under apps/" },
    kit: { type: "boolean", default: false, description: "Deploy only the kit's Workers" },
    force: { type: "boolean", default: false, description: "Deploy every kit Worker, changed or not" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      // Optional here, and only here: a bare `pithy deploy` ships each worker's top-level stanza, which
      // is not an environment at all. A value that *is* given is held to the same rule as everywhere else.
      const env = args.env === undefined ? undefined : requireEnvironment(args.env);
      const projectDir = process.cwd();
      assertDeployFlags(args);
      const selection = deploySelection(args);

      // The three gates below are about the **adopter's** Workers: their bindings, their declared
      // origins, their Workflow stanzas. `--kit` touches nothing under `apps/`, so it is not held to
      // them — a kit Worker whose resources are missing is reported as a skipped row naming the
      // provisioning command, which is the finer-grained answer to the same question.
      const gateApps = selection.apps && env !== undefined;
      // The migration warning only makes sense against a concrete remote target. A bare `pithy deploy`
      // ships each worker's top-level config, whose deployed schema is not the local dev D1 — so skip the
      // check (and its REST round trip) unless an `--env` names the environment being deployed.
      // The account first, before anything resolves a credential. It is read from the project's own
      // config and passed to every step below, rather than left to whatever a later load happens to
      // publish — a deploy that authenticates against the wrong tenant succeeds, and says nothing.
      // Refuse before anything is built or spawned. A binding with no id fails *inside* wrangler, on a
      // field the adopter never wrote, after `init`, `add`, `migrate` and `dev` have all succeeded —
      // and with no hint that provisioning was a step they had missed (#240). Only for a named `--env`:
      // a bare deploy ships the top-level stanza, whose ids `pithy dev` resolves from Miniflare.
      if (gateApps && env) await assertEnvironmentProvisioned(projectDir, env);
      // And the other half of "is this environment ready to be real": does its config name every origin
      // it will answer on (#253). Refused here for the same reason the binding check is — deploy knows
      // the environment and the config, and this is the last moment before a staging Worker starts
      // emailing real users magic links into production. Beside it rather than inside it because the two
      // are different questions with different fixes; `assertOriginsDeclared` exempts a feature
      // environment itself, which has no declared domain by design.
      if (gateApps && env) await assertOriginsDeclared(projectDir, env);
      // And the third half of it, on the same evidence and at the same moment: does this environment's
      // stanza bind what its Workers' app capabilities declare (#267)? `reconcileAppWorkflows` writes
      // that table and `pithy worker sync` is its only caller, so an adopter who declared a job and
      // never ran it shipped a Worker with no `workflows` entry and no `triggers.crons` — the binding
      // fails on the first request, and the cron simply never fires and says nothing at all. Beside the
      // origins gate rather than inside it for the same reason that one is beside the binding gate: a
      // different question with a different fix, and a feature environment is exempt from this one too.
      if (gateApps && env) await assertWorkflowsBound(projectDir, env);

      const account = await projectCloudflareAccount(projectDir);
      // **The account is settled here, before anything best-effort runs (#236).** `pendingFor` swallows
      // every failure on purpose — a database it cannot reach costs a warning line, not the deploy — and
      // a pin the credentials contradict is not a reachability failure. Swallowed, it becomes
      // `pendingMigrations: null`: an absence that reads as a fact. `cloudflareEnv` refuses it in the one
      // sentence `pithy doctor` already reads out. A *missing* pair still passes, because `wrangler
      // deploy` authenticates on its own OAuth login and always could.
      cloudflareEnv({ account });
      const pending = env ? await pendingFor(projectDir, env, account) : undefined;
      const audit = await buildAudit(projectDir, env ?? "dev", account);

      // **Step one: the adopter's Workers, ungated.** Their code is the thing that changed.
      const deploys = selection.apps ? await deployProject({ projectDir, account, env, audit }) : [];
      // A deploy that shipped but is not the thing answering at the declared address is a failure too,
      // and it fails the pipeline rather than printing a line nobody reads. Two shapes count: a
      // *consistent* mismatch, and nothing answering at all (#264). A gradual rollout and a Worker that
      // answered without a version are both inconclusive, and failing on either would train everyone to
      // ignore the check.
      const appsFailed = deploys.some((deploy) => !deploy.ok) || deployVerificationFailed(deploys);

      // **Step two: the kit's, gated.** Separately, so CI reads two exit-worthy facts rather than one.
      // `dev` is not a target here at all — see {@link KIT_IS_LOCAL_IN_DEV}.
      const runKit = selection.kit && env !== undefined && env !== LOCAL_ENVIRONMENT;
      const kit: KitDeployReport | null = runKit
        ? await deployKitWorkers({
            projectDir,
            project: requireProjectName(await loadProject(projectDir)),
            env: env as string,
            account,
            force: args.force,
          })
        : null;
      const kitFailed = kit !== null && kitDeployFailed(kit);
      const failed = appsFailed || kitFailed;

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({
            command: "deploy",
            env: env ?? null,
            pendingMigrations: pending ?? null,
            workers: deploys,
            kit: kit?.workers ?? null,
            // Beside the rows rather than among them: a problem names no capability, so it is not a
            // row — and a payload that carried it as one would say a capability failed that this run
            // never even saw. `null` when the kit half did not run, exactly as `kit` is.
            kitProblems: kit?.problems ?? null,
          })}\n`,
        );
        if (failed) process.exitCode = 1;
        return;
      }

      const warning = env ? pendingWarning(pending, env) : undefined;
      if (warning) process.stdout.write(`${warning}\n`);
      for (const deploy of deploys) process.stdout.write(`${summarizeDeploy(deploy)}\n`);
      if (kit) {
        for (const row of kit.workers) process.stdout.write(`${summarizeKitDeploy(row)}\n`);
        // After the rows, because a problem explains a set that is short rather than a Worker that
        // failed — and because an operator scanning red lines must find it whether the set was short
        // by one capability or by all of them.
        for (const problem of kit.problems) process.stdout.write(`${summarizeKitProblem(problem)}\n`);
      }
      // Said out loud rather than left as an absence: a bare deploy used to ship only `apps/`, and now
      // that it can ship both, "nothing about the kit appeared" must not be how an operator learns it.
      if (selection.kit && !runKit) {
        process.stdout.write(`${env === LOCAL_ENVIRONMENT ? KIT_IS_LOCAL_IN_DEV : NO_ENV_FOR_KIT}\n`);
      }
      if (failed) {
        process.exitCode = 1; // The per-worker failure lines are the report; exit non-zero for CI.
        return;
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});
