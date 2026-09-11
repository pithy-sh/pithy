// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS, type DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import {
  backendRoutedDispatcher,
  environmentsWrittenBeforeFailure,
  type PreflightSecretDispatcher,
  type SecretProbe,
  type SecretRotationRecorder,
} from "@pithy-sh/secrets/src/cli/dispatch";
import { secretWriteTargets } from "@pithy-sh/secrets/src/cli/writeTargets";
import { deprovisionSecrets, provisionSecrets } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { SecretBackend, SecretRegistry, SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { canonicalGlobalEnvironment, type ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { defineCommand } from "citty";
import { createProjectCliAudit } from "../audit/cliAudit";
import {
  type MintedSecret,
  mintDeclaredSecrets,
  mintedBeforeFailure,
  mintReportLines,
  storeSecretMinter,
} from "../capabilities/mintSecrets";
import {
  EXIT_ROLLED_NOT_RECORDED,
  rotationReportLines,
  runSecretRotation,
  type SecretRotationDispatcher,
  unrecordedFailure,
} from "../capabilities/rotateSecrets";
import { projectSecretApplicability } from "../capabilities/secretApplicability";
import { mergeSecretBranches, type SecretBranches, secretBranchDeclarations } from "../capabilities/secretBranches";
import {
  assertNotTheMasterKey,
  resolveSecretRegistry,
  runSecretWrite,
  secretListRows,
  secretWriteEffect,
  secretWriteReportLine,
  unresolvedNote,
} from "../capabilities/secrets";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import {
  buildManagerDeploy,
  CloudflareSecretsDeprovisioner,
  CloudflareSecretsProvisioner,
} from "../capabilities/secretsProvisioner";
import { readSecretValue } from "../capabilities/secretValue";
import { storeSecretWriter } from "../capabilities/storeSecretWrites";
import type { ConfirmedAccount } from "../cloudflare/accountAnswer";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
import { editDevSecrets } from "../devSecrets/edit";
import { resolveDevSecretsFile } from "../devSecrets/location";
import { mergedSecretRegistry, resolveDevSecretsTargets } from "../devSecrets/targets";
import { loadProject, projectCloudflareAccount, projectEnvironments, requireProjectName } from "../project/config";
import { requireManagedEnvironment } from "../project/environment";
import { resolveWorkers } from "../project/workerScope";
import { secretsStoreBindings, workerSecretRegistry } from "../provision/secretBindings";
import { removedStoreEntryNote } from "../provision/secretEntryRemedy";
import { cloudflareSecretsStore } from "../provision/store";
import { applySecretBindings } from "../provision/wranglerEnv";
import {
  formatDone,
  formatError,
  formatErrorJson,
  formatJsonLine,
  formatList,
  withErrorReporting,
} from "../terminal/output";

/**
 * The secret registry for the whole project: every Worker's, merged by secret name.
 *
 * Capabilities are per Worker, so the registry is too. The secret **name** is the join key — the same name
 * resolves the same value through any registry that declares it — so `pithy secrets` must see every declared
 * name, not just the alphabetically-first Worker's. A Worker that does not compose `secrets` simply
 * contributes nothing; when no Worker does, the capability's own actionable error is what surfaces.
 */
async function projectSecrets(projectDir: string): Promise<{ registry: SecretRegistry; branches: SecretBranches }> {
  const workers = await resolveWorkers({ projectDir });
  const registries: SecretRegistry[] = [];
  let branches: SecretBranches = {};
  let absent: unknown;
  for (const worker of workers) {
    try {
      registries.push(resolveSecretRegistry(worker.config));
    } catch (error) {
      absent = error;
      continue;
    }
    // Only from a Worker whose registry resolved: a capability's branch declaration is about the secret
    // that Worker actually composes, and reading it from one with no secrets store would offer blocks
    // for a bundle that Worker has nowhere to put.
    branches = mergeSecretBranches(branches, secretBranchDeclarations(worker.capabilities));
  }
  const first = registries[0];
  if (!first) throw absent;
  return {
    registry: registries.length === 1 ? first : (Object.assign({}, ...registries) as SecretRegistry),
    branches,
  };
}

/** The project's merged secret registry. See {@link projectSecrets}. */
async function projectSecretRegistry(projectDir: string): Promise<SecretRegistry> {
  return (await projectSecrets(projectDir)).registry;
}

/**
 * The audit emitter for a secrets command. Every value-touching write is a warning-severity event
 * (CLAUDE.md §Security), so this is built for every write and provisioning call — a no-op when
 * Cloudflare credentials or the audit capability aren't there, never a blocker.
 */
async function buildAudit(projectDir: string, env: string) {
  const vars = cloudflareEnv({ account: await projectCloudflareAccount(projectDir) });
  // Auditing spans the project, not one Worker: `audit` composed anywhere means the trail exists. Here
  // `env` really is the environment acted on, so it is also the recorded origin.
  return createProjectCliAudit({
    projectDir,
    accountId: vars.CLOUDFLARE_ACCOUNT_ID,
    apiToken: vars.CLOUDFLARE_API_TOKEN,
    env,
    actedOn: env,
  });
}

/**
 * The dispatcher a `--dry-run` gets: every seam present, none of them reachable, and none of them called.
 *
 * A dry run answers what *would* happen and must reach no account at all — which is what makes it usable
 * before the credentials exist. `rotateSecretValue` returns `unchanged` before it opens a rotation row, so
 * `openRotation` here is unreachable rather than merely unused; it throws instead of returning a plausible
 * id, because a dry run that quietly recorded a rotation would be the one thing it promises never to do.
 */
const DRY_RUN_DISPATCHER: SecretRotationDispatcher = {
  dispatch: async () => {},
  // Unreachable for the same reason `openRotation` is: `rotateSecretValue` answers `unchanged` for a dry
  // run before it asks either. It throws rather than resolving, because a dry run that quietly reached an
  // account would break the one promise it makes — and a pre-flight is a round trip to a manager.
  preflight: async () => {
    throw new ValidationError({
      message: "A dry run does not reach a secret's store.",
      detail: "DRY_RUN_DISPATCHER.preflight was reached, which means a dry run passed the refusals",
    });
  },
  openRotation: async () => {
    throw new ValidationError({
      message: "A dry run does not record a rotation.",
      detail: "DRY_RUN_DISPATCHER.openRotation was reached, which means a dry run passed the ledger open",
    });
  },
  closeRotation: async () => {},
};

/**
 * Build the live dispatcher from CF creds (`.dev.vars`, then `process.env`) and the project name.
 *
 * `requireProjectName`, never `resolveProjectName`: the target Workflow is `<project>-<env>-secrets-write`
 * and Workflow names are account-scoped, so a fallback-derived name would either dispatch nowhere or
 * dispatch this project's values into another project's manager.
 */
async function buildDispatcher(
  projectDir: string,
): Promise<PreflightSecretDispatcher & SecretProbe & SecretRotationRecorder> {
  const { accountId, apiToken } = loadCloudflareCreds(await projectCloudflareAccount(projectDir));
  const project = requireProjectName(await loadProject(projectDir));
  return buildSecretDispatcher(accountId, apiToken, project);
}

/**
 * **The dispatcher a value-touching command writes through: one per backend, chosen by the request** (#517).
 *
 * Every write used to reach {@link buildDispatcher} alone — the manager write-Workflow, which reaches one
 * environment's D1 and nothing else. A `cf-secrets-store` secret went there too, because the request said
 * nothing about where its value belonged: `pithy secrets create` wrote an encrypted row no reader looks
 * for and exited 0, and `pithy secrets rm` deleted that row and reported a revocation while the live
 * Secrets Store entry stayed present and stayed bound.
 *
 * So both writers are composed and `backendRoutedDispatcher` picks between them per request. **Every
 * value-touching command goes through it, `rotate` included** — it was left on {@link buildDispatcher}
 * for one round because a rotation also needs the ledger, which is the manager's alone, and a
 * `cf-secrets-store` rotation therefore ended in a 500 `InternalError` raised at the store write. With a
 * `provider` rotator that write is *after* the issuer has rolled the credential, so the kit asked a
 * provider for a new secret, received it, and threw before storing it — the worst possible ordering, and
 * the reason {@link buildRotationDispatcher} exists rather than a second router.
 *
 * **The store half is lazy, and that is what keeps a `d1`-only project working.** Reaching the account's
 * Secrets Store needs `SECRETS_STORE_ID`; resolving it eagerly would refuse
 * `pithy secrets create auth-session-secret` in a project that has no store and needs none — a refusal
 * earned by a value that was never going there. Nothing is resolved until a store write is dispatched,
 * or until a rotation asks for it in front of the issuer (`PreflightSecretDispatcher.preflight`).
 */
async function buildWriteDispatcher(projectDir: string): Promise<PreflightSecretDispatcher> {
  return backendRoutedDispatcher(await writeRoutes(projectDir, await buildDispatcher(projectDir)));
}

/**
 * **The dispatcher `pithy secrets rotate` writes through: the same router, plus the manager's ledger.**
 *
 * A rotation is two contracts on one object — the write, and the `pithy_secrets_rotations` row around it
 * (`#379`) — and only one of them is per backend. The row always lives in the environment's secrets D1,
 * which is the manager's alone; the write goes wherever the registry says. Composing them here rather
 * than widening `backendRoutedDispatcher` keeps the router a router: a `cf-secrets-store` writer has no
 * ledger to offer and never should.
 *
 * `preflight` rides along from the router, so the refusals a store write owns are asked by
 * `rotateSecretValue` **above the irreversible line** — including the one that used to be the whole
 * defect, an unreachable Secrets Store discovered at the write.
 */
async function buildRotationDispatcher(projectDir: string): Promise<SecretRotationDispatcher> {
  const manager = await buildDispatcher(projectDir);
  const routed = backendRoutedDispatcher(await writeRoutes(projectDir, manager));
  return {
    dispatch: (request) => routed.dispatch(request),
    preflight: (request) => routed.preflight(request),
    openRotation: (request) => manager.openRotation(request),
    closeRotation: (request) => manager.closeRotation(request),
  };
}

/** The per-backend writers, over one project resolution — the routing table both dispatchers share. */
async function writeRoutes(
  projectDir: string,
  manager: PreflightSecretDispatcher,
): Promise<Record<SecretBackend, PreflightSecretDispatcher>> {
  const account = await projectCloudflareAccount(projectDir);
  const project = requireProjectName(await loadProject(projectDir));
  return {
    d1: manager,
    "cf-secrets-store": storeSecretWriter({
      store: async () => {
        const { accountId, apiToken, storeId } = loadCloudflareCreds(account, { requireStore: true });
        return cloudflareSecretsStore(await cloudflareClients({ accountId, apiToken }), storeId);
      },
      // Provisioning's own namer, so an operator's value lands at the address `secretsStoreBindings` will
      // ask the store for. A second namer here is a write that succeeds and a binding that stays missing.
      scope: (env) => environmentScope(project, env),
    }),
  };
}

/** The CF credentials and Secrets Store id provisioning needs, from `.dev.vars` then `process.env`. */
function loadCloudflareCreds(
  account: CloudflareAccountSelection | null,
  options: { requireStore?: boolean } = {},
): {
  account: ConfirmedAccount;
  accountId: string;
  apiToken: string;
  storeId: string;
} {
  const vars = cloudflareEnv({ account });
  const confirmation = cloudflareAccountConfirmation({ account });
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
  return { account: { accountId, confirmation }, accountId, apiToken, storeId };
}

/**
 * **May a prompt be drawn — one of the two questions this command asks, and never the other one.**
 *
 * `--json` because a machine-readable run has a caller that parses one line and a prompt is not it, and
 * **stdout** because that is where the question would go: a prompt written into a file or a pipe is a
 * question nobody sees in front of a process that never returns. Both terms are about *output*, which is
 * what a prompt is.
 *
 * **stdin is deliberately absent, and its absence is the fix rather than an omission.** Every other
 * command in this CLI gates on all three, correctly, because none of them reads a document: for `add` or
 * `seed`, a pipe on stdin means only *no human*, so folding it into one gate loses nothing. `secrets`
 * does read a document, so for it stdin answers a different question — *is one on its way* — and
 * `readSecretValue` asks that of the stream it is handed (`capabilities/secretValue.ts`). One boolean
 * standing for both is what made `--json` on a terminal, and any run with output redirected to a file,
 * silently read the operator's terminal for a credential with no prompt and no masking. Two questions,
 * two answers, and neither derivable from the other.
 *
 * `ci/interactiveGate.test.ts` holds the three-term gate for every command that writes one, and records
 * why this file no longer appears in its scan.
 */
export function canPrompt(json: boolean): boolean {
  return !json && Boolean(process.stdout.isTTY);
}

/**
 * Read the secret value: from stdin when a document is piped (agent/non-interactive use), from masked
 * prompts when one can be drawn, and neither silently. Never from a flag — a value there would persist
 * in shell history and process lists.
 *
 * A `json` secret is asked for one field at a time, using each field's own `.describe()` (#516); see
 * `capabilities/secretValue.ts` for what that path does and, more often, declines to do.
 */
async function readValue(
  name: string,
  mode: "create" | "update",
  entry: SecretRegistryEntry | undefined,
  branches: readonly string[] | undefined,
  json: boolean,
): Promise<string> {
  const value = await readSecretValue({
    name,
    mode,
    entry,
    branches,
    canPrompt: canPrompt(json),
    // The stream, not a verdict about it: whether a document is coming is `process.stdin`'s own `isTTY`,
    // asked where the document would be read.
    stdin: process.stdin,
  });
  if (value === null) {
    process.stderr.write("Canceled.\n");
    process.exit(1);
  }
  return value;
}

/**
 * **Ask the rule before asking for a value.**
 *
 * `secretWriteTargets` is what decides whether a write is coherent, and `dispatchSecretWrite` asks it
 * again with nothing sent if the answer is no — that second call is what makes it a guarantee rather
 * than a courtesy. This one exists so an operator is not prompted to type a production signing key into
 * a command that was never going to run.
 *
 * The refusals `runSecretWrite` owns — an undeclared name, a keyspace — are left to it. Answering them
 * here as well would be a second producer of two more rules.
 */
function checkWriteIsCoherent(
  registry: SecretRegistry,
  mode: "create" | "update" | "delete",
  name: string,
  requested: ManagedEnvironment | undefined,
  declared: DeclaredEnvironments,
): void {
  // Before the value is asked for, and through the one owner of the rule. `runSecretWrite` raises it too;
  // this is what keeps an operator from being prompted, masked, for a value the command was never going
  // to write (#517).
  assertNotTheMasterKey(mode, name);
  const entry = registry[name];
  if (!entry || entry.keyed) return;
  secretWriteTargets({ name, backend: entry.backend, scope: entry.scope, mode, requested, declared });
}

/**
 * The environment a write's **audit** is recorded from — never the write's target, which
 * `secretWriteTargets` decides from what the operator actually typed.
 *
 * A global write has no single origin, so the canonical environment stands in: the trail has to name
 * somewhere, and the canonical one is the manager a `cf-secrets-store` write goes through anyway. The
 * environments a run *reached* are in the event's metadata, which is the field that answers where a
 * value landed.
 */
function auditOrigin(requested: ManagedEnvironment | undefined, declared: DeclaredEnvironments): string {
  return requested ?? canonicalGlobalEnvironment(declared) ?? declared[0] ?? "prod";
}

/** Shared body for create/update/rm: discover the registry, dispatch, and report the envs written. */
async function write(
  mode: "create" | "update" | "delete",
  args: { name: string; env?: string; json: boolean },
): Promise<void> {
  const projectDir = process.cwd();
  const { registry, branches } = await projectSecrets(projectDir);
  const environments = await projectEnvironments(projectDir);
  // `--env` as the operator gave it, or nothing. Not resolved to a default: the absence is the whole
  // difference between *narrow this write* and *say nothing*, and it is what the rule turns on.
  const env = args.env ? requireManagedEnvironment(args.env, environments) : undefined;
  checkWriteIsCoherent(registry, mode, args.name, env, environments);
  const value =
    mode === "delete"
      ? undefined
      : await readValue(args.name, mode, registry[args.name], branches[args.name], args.json);
  const dispatcher = await buildWriteDispatcher(projectDir);
  const audit = await buildAudit(projectDir, auditOrigin(env, environments));

  let targets: ManagedEnvironment[];
  try {
    targets = await runSecretWrite(registry, dispatcher, { mode, name: args.name, value, env, environments }, audit);
  } catch (error) {
    // **A fan-out has no rollback, so what it wrote is said before the error is.** Three environments and
    // the third throws leaves the first two holding the new value; without this the operator reads a
    // failure and has no way to know that. `withErrorReporting` then puts `{ error }` on stderr and exits
    // 1 — the streams agree, and neither reports success.
    const written = environmentsWrittenBeforeFailure(error);
    if (written.length > 0) {
      const landed = mode === "delete" ? "removed from" : "written to";
      process.stdout.write(
        args.json
          ? `${formatJsonLine({ command: `secrets ${mode}`, name: args.name, environments: written, interrupted: true })}\n`
          : `${args.name} ${landed} ${written.join(", ")} before this failed.\n`,
      );
    }
    throw error;
  }

  // **What changed, which is not always where it was dispatched** (#517). A `global` store secret is one
  // account-level entry every environment binds, so a write that reached the canonical environment's
  // manager changed the value all of them read — and reporting the dispatch target alone understated it
  // by every environment but one. `secretWriteEffect` owns the widening; both streams read it.
  const effect = secretWriteEffect(registry[args.name], targets, environments);
  if (args.json) {
    process.stdout.write(
      `${formatJsonLine({
        command: `secrets ${mode}`,
        name: args.name,
        environments: effect.environments,
        // Only when it is true, and it is the fact a machine reader needs to not treat the list above as
        // one value per environment: there is one entry, and these are the stanzas that bind it.
        ...(effect.accountEntry ? { accountEntry: true } : {}),
      })}\n`,
    );
    return;
  }
  process.stdout.write(`${secretWriteReportLine(args.name, mode, effect)}\n`);
  // **What a revocation of a store-backed secret leaves behind, said in the same breath** (#517). The
  // entry is gone, which is the act; the Worker's `wrangler.jsonc` still binds the name, and
  // `applySecretBindings` only ever adds — so nothing in the kit will take that line out and the next
  // deploy of that Worker fails on it. A `global` secret is bound by every stanza, an `environment` one
  // by the stanza this write reached — which is what the effect above already resolved.
  const removed = registry[args.name];
  if (mode === "delete" && removed?.backend === "cf-secrets-store") {
    process.stdout.write(`${removedStoreEntryNote(args.name, effect.environments)}\n`);
  }
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

/**
 * `pithy secrets rotate` — replace one secret's value against the rotation its registry entry declares.
 *
 * **One secret per invocation. There is no `--all`, and that is a decision rather than an omission.**
 *
 * The case that wants one is real: somebody has left, and every credential they could have seen needs
 * rolling today. The dashboard solved the same problem for connection signing keys and settled on *more
 * than one confirmation, plus an audit entry naming the operator* — and the second half is the half this
 * command cannot honor. `createCliAudit` resolves the actor from the Cloudflare API token and falls back
 * to `system, actorResolutionFailed` when there is none, so the one act most certain to be reviewed
 * afterwards would be recorded as *somebody with the token*. A fleet path that cannot say who took it is
 * worse than no fleet path, because it is the difference between an incident with a name on it and an
 * incident without one.
 *
 * The blast radius argues the same way from the other end. The failure this command is built around —
 * rolled at the issuer, not recorded — does not average out over ten secrets; it is ten chances to strand
 * a live credential inside one invocation, reported into one scrollback, at the hour an operator is least
 * able to read carefully. A flag one character from the ordinary command is the wrong place for that.
 *
 * **What the case gets instead**: `pithy secrets ls` names every declared secret, and a shell loop over it
 * makes the operator see the list they are about to roll before they roll it. That is a worse ergonomic
 * and a better 2am.
 *
 * `--dry-run` is here because it costs almost nothing and answers the question an operator has just before
 * the irreversible one: *is this secret rolled at somebody else's API, or minted here?*
 */
const rotate = defineCommand({
  meta: { name: "rotate", description: "Rotate one secret against its declared rotator" },
  args: {
    ...nameArg,
    ...sharedArgs,
    "dry-run": { type: "boolean", default: false, description: "Say what would happen; call nothing" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const registry = await projectSecretRegistry(projectDir);
      const environments = await projectEnvironments(projectDir);
      const env = args.env ? requireManagedEnvironment(args.env, environments) : undefined;
      const entry = registry[args.name];
      const dryRun = args["dry-run"];

      // **The dispatcher is built before anything is rolled**, and the ordering is load-bearing rather
      // than tidy. Missing credentials raise here, with the previous value untouched; built after the
      // roll, the same missing credentials would strand a live one behind a message about `pithy init`.
      // A dry run reaches no account at all, which is what makes it usable before the credentials exist.
      //
      // **Routed by backend, like every other write** (#517). It was the manager's alone, which reaches
      // one environment's D1 — so rotating a `cf-secrets-store` secret ended in a 500 raised at the
      // store write, after a `provider` rotator had already rolled the credential at its issuer.
      const dispatcher = dryRun ? DRY_RUN_DISPATCHER : await buildRotationDispatcher(projectDir);
      const audit = dryRun ? async () => {} : await buildAudit(projectDir, auditOrigin(env, environments));

      const outcome = await runSecretRotation(
        registry,
        dispatcher,
        { name: args.name, env, environments, dryRun },
        audit,
      );
      // `runSecretRotation` refuses an undeclared name before anything else happens, so reaching here with
      // no entry is impossible — this narrows for the type checker rather than for a state that can occur.
      if (!entry) throw new ValidationError({ message: `Secret '${args.name}' is not declared in the registry.` });

      if (args.json) {
        const rotations = [
          {
            name: outcome.name,
            status: outcome.status,
            rotation: outcome.kind,
            rolled: outcome.rolled,
            ...(outcome.rollFailed === undefined ? {} : { rollFailed: outcome.rollFailed }),
            recorded: outcome.recorded,
            stranded: outcome.stranded,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          },
        ];
        process.stdout.write(`${formatJsonLine({ command: "secrets rotate", name: args.name, rotations })}\n`);
      } else {
        for (const line of rotationReportLines(entry, outcome, env)) process.stdout.write(`${line}\n`);
      }

      // **The two ends of the same run, and they must never disagree.** Whatever the outcome, stdout has
      // already said per secret what happened; these decide what the shell learns.
      if (outcome.status === "unrecorded") {
        const failure = unrecordedFailure(entry, outcome, env);
        process.stderr.write(`${args.json ? formatErrorJson(failure.payload) : formatError(failure.payload)}\n`);
        // Not a throw: `withErrorReporting` would exit 1, and 1 is the status that means *the previous
        // credential is still live*. This state is the one thing in the command that is not that.
        process.exitCode = EXIT_ROLLED_NOT_RECORDED;
        return;
      }
      if (outcome.status === "failed") {
        // Ordinary: nothing was rolled, so the previous value is still live and the run can be repeated.
        // The cause is what the operator needs, and `withErrorReporting` puts it on stderr with exit 1. The
        // fallback is not decoration — `throw undefined` would exit non-zero with a blank stderr, which is
        // the one report worse than a bad one.
        throw (
          outcome.cause ??
          new ValidationError({
            message: `Secret '${args.name}' was not rotated.`,
            action: "Run it again. The previous value is still live.",
            detail: `rotate '${args.name}': store refused with no recorded cause`,
          })
        );
      }
      if (args.json) return;
      if (dryRun) {
        process.stdout.write("Dry run. Nothing rolled, nothing written.\n");
        return;
      }
      // **No `Done.` over a `manual` secret.** The lines above have just told the operator that a human has
      // to go to a console, and `Done.` under them reads as the command having handled it. The last thing
      // they see is the instruction, which is the only thing left to act on.
      if (outcome.reason === "manual") return;
      process.stdout.write(`${formatDone()}\n`);
    }),
});

const ls = defineCommand({
  meta: { name: "ls", description: "List the declared secrets" },
  args: { json: { type: "boolean", default: false, description: "Machine-readable output" } },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const registry = await projectSecretRegistry(projectDir);
      // What the configuration says each of those names can reach (#541). Never throws: an answer it
      // could not establish is an empty one, and every row then reads exactly as it did before.
      const applicability = await projectSecretApplicability(projectDir);
      const rows = secretListRows(registry, applicability.project);
      if (args.json) {
        // `unresolved` is its own key rather than a field on a row, because it is a fact about the
        // *answer* and not about any one secret: it says which environments these marks were decided
        // from. An agent acting on `applies` has to be able to tell a whole project's answer from one
        // drawn out of two of its three environments (#548).
        process.stdout.write(
          `${formatJsonLine({ command: "secrets ls", secrets: rows, unresolved: applicability.unresolved })}\n`,
        );
        return;
      }
      process.stdout.write(`${formatList(rows)}${unresolvedNote(applicability.unresolved)}\n`);
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
      // Best effort, and never a reason to refuse (#323). With a registry an edit is judged against the
      // payload each secret's destination takes; without one the file is still checked as JSONC. A
      // project whose config will not load is the state this command exists to get somebody out of.
      const targets = await resolveDevSecretsTargets(process.cwd())
        .then((resolved) => resolved.targets)
        .catch(() => []);
      const result = await editDevSecrets({ path, registry: mergedSecretRegistry(targets) });

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
      const { account, accountId, apiToken, storeId } = loadCloudflareCreds(
        await projectCloudflareAccount(projectDir),
        {
          requireStore: true,
        },
      );
      // Never `resolveProjectName`: every Secrets Store entry and the manager's token name derive from
      // this, and deprovision has to recompute them exactly. A guessed name would name resources
      // teardown can never find again.
      const project = requireProjectName(await loadProject(projectDir));
      const cf = await cloudflareClients({ accountId, apiToken });
      // Provisioning spans every managed environment, not one — "dev" is the fallback the audit
      // database resolves against when a command has no single target env (mirrors `pithy feature`).
      const provisioner = new CloudflareSecretsProvisioner({
        cf,
        account,
        project,
        storeId,
        deploy: buildManagerDeploy({ accountId, apiToken, cf, project, projectDir }),
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
      // `dev` is deliberately not among them: local dev materializes every `cf-secrets-store` secret into
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
      //
      // **A run that fails here has usually written something.** The fan-out creates a signing key per
      // environment, so a fault after the first write leaves key material behind — and until #324 the
      // report of it was assembled after the loop and died with the throw. So what landed is caught and
      // printed *before* the error is rethrown: `withErrorReporting` then writes the failure to stderr
      // and exits 1, and stdout carries what the run actually did. Both streams, and the exit code,
      // agree that it failed and name what it wrote on the way.
      const managers = await buildDispatcher(projectDir);
      let generated: MintedSecret[];
      try {
        generated = await mintDeclaredSecrets({
          registry: await projectSecretRegistry(projectDir),
          dispatcher: managers,
          probe: managers,
          environments,
          audit: await buildAudit(projectDir, "dev"),
        });
      } catch (error) {
        const landed = mintedBeforeFailure(error);
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({
              command: "secrets provision",
              environments: result.perEnv,
              wired,
              generated: landed,
              interrupted: true,
            })}\n`,
          );
        } else {
          for (const line of mintReportLines(landed)) process.stdout.write(`${line}\n`);
        }
        throw error;
      }

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
      // whether this run generated a production signing key, or found one already there. The same
      // renderer as the interrupted path above — one phrasing, so a partial report cannot read as a
      // complete one.
      for (const line of mintReportLines(generated)) process.stdout.write(`${line}\n`);
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
      const { account, accountId, apiToken, storeId } = loadCloudflareCreds(
        await projectCloudflareAccount(projectDir),
        {
          requireStore: true,
        },
      );
      const cf = await cloudflareClients({ accountId, apiToken });
      const deprovisioner = new CloudflareSecretsDeprovisioner({
        account,
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
  subCommands: { create, update, rotate, rm, ls, edit, provision, deprovision },
});
