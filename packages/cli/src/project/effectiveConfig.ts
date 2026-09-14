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
 *
 * ## `dev` is the top level, so it is not a wrangler environment
 *
 * {@link LOCAL_ENVIRONMENT} is never an `env.dev` stanza — `DeclaredEnvironments` refuses to let a project
 * declare it. A deploy for `dev` therefore ships the top-level stanza, and that is what this holds it to.
 */

import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { parse } from "comment-json";
import { wranglerConfigPath } from "../provision/featureConfig";
import { readOptionalFile } from "./readOptionalFile";

/** Wrangler's own path for the file `vite build` writes to redirect a following deploy. */
export const DEPLOY_CONFIG_REDIRECT = join(".wrangler", "deploy", "config.json");

/** The var every Pithy stanza carries, and the one the running Worker reads to know what it is. */
const ENVIRONMENT_VAR = "ENVIRONMENT";

/** The slice of a wrangler config this module reads. Everything else in the file is wrangler's business. */
interface WranglerShape {
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
  const vars = (stanza ?? config).vars;
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
  const { workerDir, env, args } = options;
  const declarationPath = wranglerConfigPath(workerDir, env ?? LOCAL_ENVIRONMENT);
  const declaration = await readConfig(declarationPath);
  // Nothing declared, nothing to hold a deploy to. `discoverWorkers` only yields Workers with a config,
  // and a feature environment that was never provisioned is `assertEnvironmentProvisioned`'s sentence.
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
  const shipping = identityOf(effective.path, config, environmentFromArgs(args), effective.redirected);
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
    action: effective.redirected
      ? `Build ${workerDir} for ${named} — CLOUDFLARE_ENV is what selects the stanza — then run the deploy again.`
      : `Deploy ${workerDir} against ${declarationPath}, or point the configuration at ${named}.`,
    // The effective path is repeated here rather than left to `message`, because a deploy row and a
    // `--json` payload carry the `detail` alone — and the file about to be shipped is the whole
    // diagnostic. A refusal an operator cannot act on is a refusal they will route around.
    detail: `${effective.path} deploys ${shipping.name ?? "an unnamed Worker"} as ENVIRONMENT=${shipping.environment ?? "unset"}; ${declarationPath} declares ${named} as ${wanted.name ?? "an unnamed Worker"} with ENVIRONMENT=${wanted.environment ?? "unset"}.`,
  });
}
