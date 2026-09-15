// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **What `wrangler deploy` will actually read, and whether it is the environment that was asked for.**
 *
 * ## The failure this exists to make impossible
 *
 * `pithy deploy --env staging` shipped a Worker composed as `dev`, publicly, and reported success (#579).
 * Two mechanisms, each correct on its own, met: the front-end build was handed `ENVIRONMENT`, which
 * `@cloudflare/vite-plugin` does not read to select a wrangler environment — it reads `CLOUDFLARE_ENV` —
 * so the build emitted the **top-level** stanza; and `vite build` writes `.wrangler/deploy/config.json`,
 * which redirects the following `wrangler deploy` to that flattened build output. A flattened config has
 * no `env` section, so `--env staging` on the argv matched nothing and was silently ignored. Neither half
 * errored. The three gates `pithy deploy` already runs all read the **source** `wrangler.jsonc`, where
 * staging is declared perfectly — and the file that then shipped is one none of them ever sees.
 *
 * ## So the rule is about the file that ships, not about a variable
 *
 * **A deploy publishes the configuration its project declares for the environment that was requested.**
 * That is the whole invariant, and it is knowable after the build and before the upload: the effective
 * config is a file on disk, and what it deploys as is written in it. Setting `CLOUDFLARE_ENV` fixes the
 * instance; this fixes the class, because the next mechanism that substitutes a configuration reaches the
 * same comparison.
 *
 * ## Why it models wrangler rather than asking it
 *
 * The answer has to exist before wrangler is spawned — after that the Worker is live — and in a checkout
 * where wrangler may not be installed at all. So the three rules below are wrangler's own, read out of
 * `wrangler@4.125.0` and stated here rather than inferred:
 *
 * - **An explicit `--config` beats the redirect.** `resolveWranglerConfigPath` returns it without ever
 *   looking for `.wrangler/deploy/config.json`. Measured on the real binary in #579, and the reason
 *   "just pass `--config`" is not the fix: the source config carries no `assets.directory` for a Worker
 *   with a front end, so that path fails instead of shipping the wrong thing.
 * - **The redirect is searched for upwards** from the Worker's directory, and its `configPath` resolves
 *   against the directory holding `.wrangler/deploy/config.json`.
 * - **A redirected config ignores `--env` entirely.** wrangler keeps the flattened stanza and only
 *   compares the requested name against a `targetEnvironment` field *if the build recorded one* — and
 *   the build that produced #579 recorded none, which is exactly why nothing complained.
 * - **Otherwise the script name is `env.<name>.name`, or `<top-level name>-<name>`**, via wrangler's
 *   `appendEnvName`, whether or not the `env.<name>` section exists.
 * - **The environment is `args.env ?? CLOUDFLARE_ENV`**, so the argv is only half of what selects a
 *   stanza. The other half is the shell the spawn inherits — see {@link selectedEnvironment}. This gate
 *   shipped reading the argv alone, which meant a bare `pithy deploy` under an exported
 *   `CLOUDFLARE_ENV=prod` published prod while the gate checked the top-level stanza and approved it:
 *   the gate blessing exactly the class of mistake it exists to refuse. A gate that models fewer inputs
 *   than the thing it gates is not a narrow gate, it is a hole shaped like its own subject.
 *
 * ## `dev` is the top level, so it is not a wrangler environment
 *
 * {@link LOCAL_ENVIRONMENT} is never an `env.dev` stanza — `DeclaredEnvironments` refuses to let a project
 * declare it. A deploy for `dev` therefore ships the top-level stanza, and that is what this holds it to.
 */

import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { parse } from "comment-json";
import { wranglerConfigPath } from "../provision/featureConfig";
import { readOptionalFile } from "./readOptionalFile";

/** Wrangler's own path for the file `vite build` writes to redirect a following deploy. */
export const DEPLOY_CONFIG_REDIRECT = join(".wrangler", "deploy", "config.json");

/** The var every Pithy stanza carries, and the one the running Worker reads to know what it is. */
const ENVIRONMENT_VAR = "ENVIRONMENT";

/**
 * Wrangler's own name for the variable that selects a stanza when the argv names none.
 *
 * Not a Pithy name and not an alias of `ENVIRONMENT`: they are two variables doing two jobs, which is
 * the whole of #579. This one is read here because wrangler reads it — see {@link selectedEnvironment}.
 */
export const CLOUDFLARE_ENV_VAR = "CLOUDFLARE_ENV";

/**
 * **wrangler's own spelling for "the top-level stanza, and I mean it."**
 *
 * `args.env ?? getCloudflareEnv()` is a `??`, so an `--env` parsed as the empty string suppresses the
 * variable outright, and the branch that follows is `if (envName)` rather than a presence test — the
 * empty string then resolves to the top level. wrangler names this exact form itself, in the warning it
 * prints for a command that specified no environment: *"If your intention is to use the top-level
 * environment of your configuration simply pass an empty string to the flag."* Read out of
 * `wrangler-dist/cli.js` at 4.125.0, alongside the `??` at its `normalizeAndValidateConfig`.
 *
 * It is a constant rather than a literal at a call site because the whole of #584 is that **an argv
 * which omits it is indistinguishable from one that meant to**: the omission publishes the right Worker
 * on a machine that exports nothing and `<name>-prod` on the next one. A name is something a reader can
 * find, and something {@link assertPublishesDeclaredWorker} can name in a refusal.
 */
export const TOP_LEVEL_STANZA_ARG = "--env=";

/**
 * **wrangler's own switch for "create nothing", and the only one that works (#589).**
 *
 * `experimental-provision` is `default: true, hidden: true, alias: ["x-provision"]` on every `wrangler
 * deploy` that is not a dry run, read out of `wrangler-dist/cli.js` at 4.125.0 and re-checked at 4.131.2.
 * Under it a binding wrangler cannot resolve is inherited from the live script's settings, then connected
 * by name, and *created* when both fail — which is how a `pithy deploy --env staging` left
 * `dash-dev-secrets` and `dash-dev-db` on an account seven seconds before the upload.
 *
 * **Why the argv and not the config.** It covers eight binding kinds — KV, D1, R2, queues, AI Search,
 * agent memory, dispatch namespaces, Flagship — and for R2, queues and the namespace kinds the name *is*
 * the id, so a named bucket looks fully specified to any read of a file while wrangler creates it. No
 * reading covers a kind wrangler adds later. wrangler's own switch covers all of them, now and next.
 * `--experimental-auto-create=false` does not: it leaves named resources to be created regardless.
 *
 * **Why it fails loudly if wrangler ever drops it.** wrangler rejects unknown arguments, so an argv carrying
 * a flag it no longer knows exits 1 before uploading anything. The failure mode is a refused deploy, never
 * a resource.
 */
export const NO_PROVISION_ARG = "--experimental-provision=false";

/** wrangler's end-of-options marker: every token after it is a positional, whatever it looks like. */
const END_OF_OPTIONS = "--";

/**
 * The option name one flag-shaped token sets, lowercased with its dashes, `no-` prefix and value dropped —
 * or `null` for a token that is not an option. `--experimentalProvision=true` and `--x-provision` both
 * come back naming provisioning, which is the point: yargs camel-cases and aliases, and this gate must not
 * have to know which spellings it accepts this release.
 */
function optionName(token: string): string | null {
  if (!token.startsWith("-") || token === "-") return null;
  const name = (token.split("=", 1)[0] as string).replace(/^-+/, "").replace(/^no-/i, "");
  return name.toLowerCase().replace(/-/g, "");
}

/**
 * **Refuse unless this argv makes wrangler create nothing.**
 *
 * What must be true is that wrangler's provisioning is off for this spawn, and the argv is the whole of
 * how that is decided — there is no config key or variable for it. So it is stated as: the argv carries
 * {@link NO_PROVISION_ARG} as an option, and **it is the only statement about provisioning the argv
 * makes.** Any other token naming it — `--x-provision`, `--experimental-provision`, a camel-cased
 * `--experimentalProvision=true` — is refused rather than reasoned about, because which of two statements
 * yargs honors is a thing this gate should not be modeling. Anything whose option name mentions
 * provisioning counts, so an alias wrangler adds later is refused too. Only tokens before `--` are options;
 * the switch written after one does nothing, and is refused.
 *
 * **Where it is asked.** `runWrangler` asks it of every argv, first, so no spawn through the seam — under
 * any name the seam is called by — reaches wrangler without it. The two deploy issuers ask it earlier as
 * well, beside their other gates and before a config is written or read, so a lost switch is refused
 * there with the rest. `ci/deployCallSites.test.ts` holds both, and each issuer's argv literal to the
 * switch. A spawn that goes around the seam is `ci/cloudflareChildEnv.test.ts`'s to refuse.
 *
 * **What it does not see.** It holds the argv it is handed, and nothing else. It does not model yargs
 * beyond "the one option naming provisioning is this one": a wrangler that read provisioning from
 * somewhere other than the argv would pass it, and 4.125.0 reads no config key or variable for it.
 */
export function assertCreatesNoResources(args: readonly string[]): void {
  const end = args.indexOf(END_OF_OPTIONS);
  const options = end === -1 ? args : args.slice(0, end);
  const statements = options.filter((token) => optionName(token)?.includes("provision") ?? false);
  if (statements.length === 1 && statements[0] === NO_PROVISION_ARG) return;
  throw new InternalError({
    message: "This deploy could create Cloudflare resources, so nothing was deployed.",
    action: `Deploy with ${NO_PROVISION_ARG} and nothing else about provisioning. Creating resources is pithy provision's job.`,
    detail: `wrangler creates any binding's resource it cannot find unless provisioning is off. The argv was: ${args.join(" ")}.`,
  });
}

/** The slice of a wrangler config this module reads. Everything else in the file is wrangler's business. */
export interface WranglerShape {
  name?: unknown;
  vars?: Record<string, unknown>;
  env?: Record<string, WranglerShape | undefined>;
}

/**
 * Who a configuration says this deploy is — the two facts that distinguish one environment from another
 * on the account, and the two that were wrong in #579.
 *
 * `name` is the script Cloudflare will hold the upload under; `environment` is `vars.ENVIRONMENT`, which
 * is what `compositionEnvironment` reads at runtime and therefore what decided that a dev login route
 * mounted itself on a public URL. Either being `null` means the configuration does not say.
 */
export interface DeployIdentity {
  /** The file this identity was read out of. */
  readonly path: string;
  /** The Worker script name this configuration deploys as, or `null` when it names none. */
  readonly name: string | null;
  /** `vars.ENVIRONMENT` — the environment the deployed Worker will believe it is in. */
  readonly environment: string | null;
}

/** Read and parse one wrangler config (JSON or JSONC), or `null` when there is no such file. */
async function readConfig(path: string): Promise<WranglerShape | null> {
  const raw = await readOptionalFile(path);
  if (raw === null) return null;
  try {
    return parse(raw) as unknown as WranglerShape;
  } catch (cause) {
    throw new ConflictError(
      {
        message: `${path} is not valid configuration.`,
        action: "Fix that file, then run the command again.",
        detail: `Failed to parse ${path} as JSON/JSONC.`,
      },
      { cause },
    );
  }
}

/** A string field, or `null` for anything that is not a non-empty string. */
function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The wrangler environment name for a Pithy environment: `undefined` for a bare deploy and for `dev`,
 * which is the top-level stanza rather than an `env.dev` (see the module note).
 *
 * One function, because the argv, the build's `CLOUDFLARE_ENV`, and this gate all have to agree about
 * which stanza is being asked for. Answering it in three places is how they come to disagree.
 */
export function wranglerEnvironment(env: string | undefined): string | undefined {
  return env === undefined || env === LOCAL_ENVIRONMENT ? undefined : env;
}

/**
 * **The stanza wrangler reads for one environment: that `env.<name>`, or the top level.**
 *
 * The top level for no environment, and — wrangler's one special case — for an environment the file has
 * no stanza for: it warns and reuses the top level as the stanza, so a Worker with no `env.staging` ships
 * dev's bindings as staging. An environment that *is* found is that stanza alone: bindings are not
 * inherited, so a stanza declaring no `d1_databases` deploys with none rather than with the top level's.
 *
 * One function, because {@link identityOf} and `provision/unprovisioned.ts` ask it about the same deploy
 * and a second answer is how they come to disagree.
 */
export function stanzaOf<Shape extends { env?: Record<string, unknown> }>(
  config: Shape,
  env: string | undefined,
): Shape {
  if (env === undefined) return config;
  const stanza = config.env?.[env];
  return stanza !== null && typeof stanza === "object" ? (stanza as Shape) : config;
}

/**
 * Who this configuration deploys as, under wrangler's rules, for a given wrangler environment.
 *
 * `redirected` is not decoration: a redirected (build-output) config has no environments and wrangler
 * keeps its flattened stanza whatever `--env` said. Modeling that is the whole point — it is the
 * behavior that made #579 silent.
 */
export function identityOf(
  path: string,
  config: WranglerShape,
  env: string | undefined,
  redirected: boolean,
): DeployIdentity {
  if (env === undefined || redirected) {
    return { path, name: text(config.name), environment: text(config.vars?.[ENVIRONMENT_VAR]) };
  }
  const stanza = config.env?.[env];
  // wrangler's `appendEnvName`: a stanza that names nothing deploys as `<top-level name>-<env>`, and so
  // does an environment with no stanza at all (it reuses the top level and still appends).
  const top = text(config.name);
  const name = text(stanza?.name) ?? (top === null ? null : `${top}-${env}`);
  // `vars` is not inherited by environments, so the stanza's block replaces the top level's outright —
  // except in wrangler's one special case, where a missing stanza reuses the top level as the stanza.
  const { vars } = stanzaOf(config, env);
  return { path, name, environment: text(vars?.[ENVIRONMENT_VAR]) };
}

/** Every directory from `from` up to the filesystem root, nearest first — wrangler's own upward search. */
function upwards(from: string): string[] {
  const dirs: string[] = [];
  let current = resolve(from);
  const { root } = parsePath(current);
  while (true) {
    dirs.push(current);
    if (current === root) return dirs;
    const parent = dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

/**
 * The build-output config a `.wrangler/deploy/config.json` redirects to, or `null` when none is found.
 *
 * Searched upward from the Worker's directory and resolved against the redirect file's own directory,
 * because that is what wrangler does. A redirect naming nothing is not this module's to refuse — wrangler
 * says so in its own words, and a second opinion here would only be a second wording.
 */
export async function redirectedConfig(workerDir: string): Promise<string | null> {
  for (const dir of upwards(workerDir)) {
    const redirect = join(dir, DEPLOY_CONFIG_REDIRECT);
    const raw = await readOptionalFile(redirect);
    if (raw === null) continue;
    let configPath: unknown;
    try {
      ({ configPath } = parse(raw) as unknown as { configPath?: unknown });
    } catch {
      return null;
    }
    const target = text(configPath);
    if (target === null) return null;
    return isAbsolute(target) ? target : resolve(dirname(redirect), target);
  }
  return null;
}

/** The path an explicit `--config`/`-c` on a wrangler argv names, or `undefined` when there is none. */
export function configFromArgs(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--config" || arg === "-c") return args[index + 1];
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
  }
  return undefined;
}

/** The wrangler environment an argv selects — `--env <name>`, `--env=<name>`, or `-e <name>`. */
export function environmentFromArgs(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--env" || arg === "-e") return args[index + 1];
    if (arg.startsWith("--env=")) return arg.slice("--env=".length);
  }
  return undefined;
}

/**
 * **The stanza a wrangler spawn will actually select — the argv *and* the environment it inherits.**
 *
 * `args.env ?? getCloudflareEnv()`, read out of wrangler 4.131.2's own `normalizeAndValidateConfig`.
 * Both halves matter, and reading only the first is how a gate blesses the mistake it exists to refuse:
 * an operator with `CLOUDFLARE_ENV=prod` exported in their shell who runs a bare `pithy deploy` gets the
 * **prod** stanza published, while an argv-only reading expects the top-level one and sees nothing wrong.
 *
 * **Empty is unset**, because wrangler branches on `if (envName)` rather than on `!== undefined` — so a
 * `CLOUDFLARE_ENV=` that a script exports to mean "the top level" means exactly that here too. The `??`
 * chain is wrangler's own precedence verbatim: an `--env=` on the argv suppresses the variable, then
 * resolves to the top level, which is what wrangler does with the empty string it parses out.
 *
 * Every caller that asks "what will this spawn publish" asks here. Answering it twice is how the argv
 * and the environment come to disagree about one deploy.
 */
export function selectedEnvironment(args: readonly string[], processEnv: NodeJS.ProcessEnv): string | undefined {
  const selected = environmentFromArgs(args) ?? processEnv[CLOUDFLARE_ENV_VAR];
  return selected === undefined || selected === "" ? undefined : selected;
}

/** What one worker's deploy will actually read, before it reads it. */
export interface EffectiveConfig {
  /** The file wrangler will resolve its configuration from. */
  readonly path: string;
  /** Whether it got there through a `.wrangler/deploy/config.json` redirect. */
  readonly redirected: boolean;
}

/**
 * The configuration this exact argv will make wrangler read, from this exact directory.
 *
 * Asked of the argv rather than of the code that built it, so a call site that starts passing `--config`
 * is covered by the gate on the day it does rather than on the day someone remembers to update it.
 */
export async function effectiveDeployConfig(workerDir: string, args: readonly string[]): Promise<EffectiveConfig> {
  const explicit = configFromArgs(args);
  if (explicit !== undefined) {
    return { path: isAbsolute(explicit) ? explicit : resolve(workerDir, explicit), redirected: false };
  }
  const redirect = await redirectedConfig(workerDir);
  if (redirect !== null) return { path: redirect, redirected: true };
  return { path: join(workerDir, "wrangler.jsonc"), redirected: false };
}

/** What {@link assertDeploysRequestedEnvironment} needs to answer. */
export interface AssertDeploysRequestedEnvironmentOptions {
  /** The Worker's own directory — where wrangler will be spawned. */
  readonly workerDir: string;
  /** The environment this deploy was asked for. `undefined` is a bare deploy of the top-level stanza. */
  readonly env: string | undefined;
  /** The exact argv about to be handed to wrangler. */
  readonly args: readonly string[];
  /**
   * The environment wrangler will inherit — `process.env` at the one real call site.
   *
   * **Stated by the caller, with no default.** It is half of what selects the stanza
   * ({@link selectedEnvironment}), so a gate that reached for `process.env` itself would be a gate whose
   * answer a test cannot state and a developer's exported shell variable can change. Passing `{}` is the
   * deliberate "nothing was inherited", and it is visible in a diff.
   */
  readonly processEnv: NodeJS.ProcessEnv;
}

/** What {@link refusalAction} needs to name the one thing that would fix this deploy. */
interface RefusalActionOptions {
  /** The Worker's own directory. */
  readonly workerDir: string;
  /** The declaration this deploy was held to. */
  readonly declarationPath: string;
  /** How the requested environment reads in a sentence. */
  readonly named: string;
  /** Whether wrangler reached its configuration through a build's redirect. */
  readonly redirected: boolean;
  /** The stanza actually selected, and `true` when the inherited variable is what selected it. */
  readonly selected: string | undefined;
  readonly fromVariable: boolean;
}

/**
 * **The one move that fixes this deploy, named after the thing that actually chose the wrong stanza.**
 *
 * Three causes, three sentences, because an operator handed the wrong one acts on it and watches the
 * same refusal come back — which is how a gate teaches people to route around it. A build that emitted
 * another stanza is rebuilt; a shell that exported `CLOUDFLARE_ENV` is the shell's to fix, and an
 * operator told to rebuild would never find it; anything else is the configuration itself.
 */
function refusalAction(options: RefusalActionOptions): string {
  const { workerDir, declarationPath, named, redirected, selected, fromVariable } = options;
  if (redirected) {
    return `Build ${workerDir} for ${named} — ${CLOUDFLARE_ENV_VAR} is what selects the stanza — then run the deploy again.`;
  }
  if (fromVariable) {
    return `${CLOUDFLARE_ENV_VAR}=${selected} in this shell is what selects that stanza. Unset it, or deploy ${selected}.`;
  }
  return `Deploy ${workerDir} against ${declarationPath}, or point the configuration at ${named}.`;
}

/**
 * **Refuse unless the configuration wrangler is about to read is the requested environment's.**
 *
 * Two files, read independently, compared on the two facts that identify a deploy:
 *
 * - the **declaration** — `wranglerConfigPath(workerDir, env)`, the same resolver `migrate`, `seed` and
 *   `provision` use for "which bytes describe this environment": the tracked `wrangler.jsonc`, or the
 *   generated config under `.wrangler/` for a feature environment;
 * - the **effective config** — whatever this argv makes wrangler read.
 *
 * When they are the same file the comparison is still real, because the identity on each side is
 * resolved for a different thing: the declaration for the environment that was *requested*, the effective
 * config for the environment this *argv* selects. An argv that lost its `--env` fails here.
 *
 * It refuses rather than warns, and it names the file it was about to ship, because the one thing an
 * operator cannot do after the upload is take it back.
 */
export async function assertDeploysRequestedEnvironment(
  options: AssertDeploysRequestedEnvironmentOptions,
): Promise<void> {
  const { workerDir, env, args, processEnv } = options;
  const declarationPath = wranglerConfigPath(workerDir, env ?? LOCAL_ENVIRONMENT);
  const declaration = await readConfig(declarationPath);
  // Nothing declared, nothing to hold a deploy to. `discoverWorkers` only yields Workers with a config,
  // and a feature environment that was never provisioned has no generated config for wrangler to read —
  // it refuses a `--config` naming a missing file, and a front end's build fails before it on the same path.
  if (declaration === null) return;

  const effective = await effectiveDeployConfig(workerDir, args);
  const config = await readConfig(effective.path);
  if (config === null) {
    throw new ConflictError({
      message: `${effective.path} is not there, so this deploy has no configuration.`,
      action: `Build ${workerDir} again, then run the deploy again.`,
      detail: `wrangler would read ${effective.path} for ${env ?? "the top-level stanza"}.`,
    });
  }

  const wanted = identityOf(declarationPath, declaration, wranglerEnvironment(env), false);
  // Both of wrangler's inputs, in wrangler's own precedence. Reading the argv alone was this gate's own
  // hole: the argv is what `deployProject` writes, and the variable is what the operator's shell did.
  const selected = selectedEnvironment(args, processEnv);
  const shipping = identityOf(effective.path, config, selected, effective.redirected);
  const named = env ?? "the top-level stanza";

  if (wanted.name === null && wanted.environment === null) {
    throw new ConflictError({
      message: `${declarationPath} says nothing about ${named}, so nothing can hold this deploy to it.`,
      action: `Give that file a top-level "name", or an env.${env ?? LOCAL_ENVIRONMENT}.name.`,
      detail: `A deploy is held to the script name and vars.ENVIRONMENT its configuration declares; this one declares neither.`,
    });
  }

  const nameDisagrees = wanted.name !== null && shipping.name !== wanted.name;
  // Only when the declaration states one. A project that sets no `ENVIRONMENT` var has nothing to
  // disagree with, and inventing an expectation for it would refuse a deploy that is perfectly correct.
  const environmentDisagrees = wanted.environment !== null && shipping.environment !== wanted.environment;
  if (!nameDisagrees && !environmentDisagrees) return;

  throw new ConflictError({
    message: `${effective.path} is not ${named}'s configuration, so nothing was deployed.`,
    action: refusalAction({
      workerDir,
      declarationPath,
      named,
      redirected: effective.redirected,
      selected,
      // The variable is what selected it exactly when the argv named nothing and something was selected
      // anyway. Anything else would tell an operator to unset a variable they never set.
      fromVariable: environmentFromArgs(args) === undefined && selected !== undefined,
    }),
    // The effective path is repeated here rather than left to `message`, because a deploy row and a
    // `--json` payload carry the `detail` alone — and the file about to be shipped is the whole
    // diagnostic. A refusal an operator cannot act on is a refusal they will route around.
    detail: `${effective.path} deploys ${shipping.name ?? "an unnamed Worker"} as ENVIRONMENT=${shipping.environment ?? "unset"}; ${declarationPath} declares ${named} as ${wanted.name ?? "an unnamed Worker"} with ENVIRONMENT=${wanted.environment ?? "unset"}.`,
  });
}

/** What {@link assertPublishesDeclaredWorker} needs to answer. */
export interface AssertPublishesDeclaredWorkerOptions {
  /** Where the configuration is written — named in the refusal, because it is the thing about to ship. */
  readonly configPath: string;
  /** The configuration itself, already in hand. Generated configs are built, not read back off disk. */
  readonly config: WranglerShape;
  /** The exact argv about to be handed to wrangler. */
  readonly args: readonly string[];
  /**
   * The environment wrangler will inherit — `process.env` at the one real call site.
   *
   * Required, with no default, for {@link AssertDeploysRequestedEnvironmentOptions.processEnv}'s reason:
   * it is half of what selects a stanza, and a gate reaching for `process.env` itself is a gate whose
   * answer a test cannot state and a developer's exported shell variable can change.
   */
  readonly processEnv: NodeJS.ProcessEnv;
}

/**
 * **Refuse unless this spawn publishes the Worker its configuration names — in every shell, not this one.**
 *
 * The sibling of {@link assertDeploysRequestedEnvironment}, for the deploys that have no second file to
 * be held against. A capability host's configuration is *generated*: one complete file per environment,
 * whose `name` already carries the environment (`acme-prod-email`) and whose `env` section does not
 * exist. There is no declaration to compare it with, so the invariant is stated about the file itself.
 *
 * ## Two checks, because one of them is green on the machine that writes the defect
 *
 * 1. **The name this spawn publishes is the name the configuration declares.** wrangler's
 *    `appendEnvName` runs whether or not the stanza exists — a generated config has no `env` section, so
 *    the missing-stanza branch only *warns* and appends anyway — which is how `CLOUDFLARE_ENV=prod`
 *    published `acme-prod-email-prod` (#584). {@link identityOf} and {@link selectedEnvironment} answer
 *    this; neither rule is restated here.
 * 2. **And it is that name whatever the shell says.** An argv naming no stanza leaves the choice to
 *    `CLOUDFLARE_ENV`, which means check 1 passes on a clean machine and fails on an operator's. That is
 *    precisely how #584 survived a green suite: the defect had no symptom in the shell it was written
 *    in. So the argv must *state* its stanza — `--env <name>`, or {@link TOP_LEVEL_STANZA_ARG} for the
 *    top level — and an argv that states none is refused before any shell is consulted.
 *
 * Check 1 runs first so that an operator who already has the variable exported is handed the sentence
 * about their shell rather than one about an argv they did not write.
 *
 * **Not the rule `pithy deploy` follows, and deliberately.** A bare `pithy deploy` states no stanza and
 * refuses instead, because `CLOUDFLARE_ENV` also steers the front-end build whose output is what ships:
 * suppressing it on the upload alone would leave the build pointed at one stanza and the deploy at
 * another, which is #579 with the halves swapped. A host deploy runs no build, so there is nothing for
 * the variable to be an input to.
 */
export function assertPublishesDeclaredWorker(options: AssertPublishesDeclaredWorkerOptions): void {
  const { configPath, config, args, processEnv } = options;
  const declared = text(config.name);
  if (declared === null) {
    throw new ConflictError({
      message: `${configPath} names no Worker, so nothing was deployed.`,
      action: `Give that configuration a "name", then run the command again.`,
      detail: `A generated host configuration is held to the Worker name it declares; this one declares none.`,
    });
  }

  const selected = selectedEnvironment(args, processEnv);
  const shipping = identityOf(configPath, config, selected, false);
  const stated = environmentFromArgs(args);

  if (shipping.name !== declared) {
    // The variable is what selected it exactly when the argv named nothing and something was selected
    // anyway. Anything else would tell an operator to unset a variable they never set.
    const fromVariable = stated === undefined && selected !== undefined;
    throw new ConflictError({
      message: `${configPath} would not publish ${declared}, so nothing was deployed.`,
      action: fromVariable
        ? `${CLOUDFLARE_ENV_VAR}=${selected} in this shell is what appends that suffix. Unset it, then run the command again.`
        : `Deploy ${configPath} with ${TOP_LEVEL_STANZA_ARG}, which is wrangler's spelling for the top-level stanza.`,
      // Repeated in the detail rather than left to the message, because a `--json` row carries the
      // detail alone and the name about to be published is the whole diagnostic.
      detail: `${configPath} declares ${declared} and this deploy would publish ${shipping.name ?? "an unnamed Worker"}; wrangler resolves its environment as --env ?? ${CLOUDFLARE_ENV_VAR} and appends the result to the name.`,
    });
  }

  if (stated === undefined) {
    throw new ConflictError({
      message: `${configPath} would publish ${declared} here and something else in another shell, so nothing was deployed.`,
      action: `Deploy ${configPath} with ${TOP_LEVEL_STANZA_ARG}, which is wrangler's spelling for the top-level stanza.`,
      detail: `This argv states no stanza, so wrangler selects one from ${CLOUDFLARE_ENV_VAR} and appends it to ${declared}. An argv that states its own stanza publishes the same Worker on every machine.`,
    });
  }
}
