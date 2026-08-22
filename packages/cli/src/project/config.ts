// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { access, copyFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProfileOverride } from "@pithy-sh/cloudflare/src/tokens/profiles";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import {
  causeMessage,
  failurePosition,
  isBuildFailureWrapper,
  prop,
  rootCause,
  safeReason,
  unresolvedSpecifier,
} from "@pithy-sh/core/src/error/cause";
import { fromZodError, InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import { DEFAULT_ENVIRONMENTS, DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { assertValidProjectName, kebab } from "@pithy-sh/core/src/naming/resource";
import { z } from "zod";
import { CloudflareAccountName } from "../cloudflare/config";
import { discoverWorkers } from "./workers";

/** Adopter token configuration: per-profile overrides of the predefined defaults (permissions/resources/store). */
export interface TokenConfig {
  /** Profile name → the fields to override on that profile's predefined default. */
  overrides?: Record<string, ProfileOverride>;
}

/** Adopter `pithy seed` configuration. */
export interface SeedProjectConfig {
  /**
   * Compose in `example`-flagged seed sets (tiny demo fixtures a capability ships for a quick look).
   * Default off — an adopter opts in per project, and an example set never targets production
   * regardless of this setting (its own `environments` allowlist excludes it).
   */
  includeExamples?: boolean;
  /**
   * Environment names this project treats as production, beyond the built-in `production`/`prod`.
   * Any env named here (case-insensitive) requires the hard type-to-confirm phrase, not just `--yes` —
   * so a project whose production environment is named `live`, `prod-eu`, `main`, etc. gets the same
   * strongest gate as the canonical names. List every production-class environment you run.
   */
  productionEnvironments?: readonly string[];
}

/**
 * The **root** `pithy.config.ts`: project identity and project-wide policy. It deliberately carries no
 * capabilities — what a Worker is *made of* is per-Worker and lives in `apps/<name>/pithy.config.ts`
 * ({@link WorkerConfig}). These three settings are the ones that cannot be per-Worker:
 *
 * - `name` is the first segment of every feature resource name and the only key teardown has to find them by,
 *   so it must be one stable value for the whole project.
 * - `environments` is the set of environments the project has — the second segment of the same names, and
 *   the set every command that iterates environments has to agree on.
 * - `tokens` configures account-level Cloudflare API token profiles.
 * - `seed.productionEnvironments` is a safety policy; a Worker must not be able to quietly omit it.
 */
export interface ProjectConfig {
  /**
   * The project name — a short, hyphenated-lowercase identifier (e.g. `acme`). It is the branch-first
   * prefix `pithy feature` names every Cloudflare resource under (`<project>-f<issue>-<slug>-<resource>`),
   * so the CF dashboard groups a feature's resources and teardown finds them by prefix. Optional; when
   * absent it falls back to the app Worker's `wrangler.jsonc` name, then the project directory name.
   */
  name?: string;
  /**
   * Every deployed environment this project has, e.g. `["staging", "prod"]` — the **second** segment of
   * every Cloudflare name it composes, and the other half of the budget `name` is already governed by.
   * Optional; absent means {@link DEFAULT_ENVIRONMENTS}, which is what the scaffold hardcoded before this
   * setting existed.
   *
   * Typed `unknown` for the same reason {@link ProjectConfig.cloudflare} is: this file is the adopter's own
   * TypeScript, `loadProject` imports it live, and duck-typing is the only other gate on it — so an
   * unvalidated entry would reach a resource name as whatever they typed. {@link loadProjectEnvironments}
   * is the gate.
   */
  environments?: unknown;
  /** Overrides for the predefined CF token profiles (`pithy token`). Optional. */
  tokens?: TokenConfig;
  /** `pithy seed` settings. Optional; defaults to no example seeds. */
  seed?: SeedProjectConfig;
  /**
   * Which Cloudflare account this project belongs to — `{ accountName?, accountId? }`, validated by
   * {@link loadProjectCloudflare}. Optional, and absent means exactly what it always meant: the
   * credentials come from `<config>/cloudflare.json`.
   *
   * Typed `unknown` for the same reason {@link WorkerConfig.domains} is: this file is the adopter's own
   * TypeScript, `loadProject` imports it live, and duck-typing is the only other gate on it — so an
   * unvalidated `accountName` would reach a `join` as whatever they typed.
   */
  cloudflare?: unknown;
}

/**
 * The root config's `cloudflare` block: **which Cloudflare account this project belongs to** (#206).
 *
 * `<config>/cloudflare.json` is account-scoped, on the reasoning that one account holds many projects
 * (#182). That reasoning is right and incomplete: it assumes one account per *machine*. A developer
 * working across two companies has two, and without this block every project on the machine reads the
 * same file — so switching accounts means editing that file in place and every project silently follows.
 *
 * **Strict, because a dropped key here is the whole failure mode.** A misspelled `accountid` that parsed
 * to "no pin" would leave the project with exactly the silent, unverified resolution the pin exists to
 * end, and nothing would say so.
 */
export const ProjectCloudflare = z
  .strictObject({
    accountName: CloudflareAccountName.optional().describe(
      "Selects <config>/cloudflare.<name>.json. Absent selects cloudflare.json, exactly as before.",
    ),
    accountId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The account this project belongs to. An identifier, not a secret — safe in a repository, including a public one — and verified against whatever the credentials resolve to.",
      ),
  })
  .describe("Which Cloudflare account this project's credentials must belong to, from the root pithy.config.ts.");

/** Which Cloudflare account this project belongs to. Same name as its schema, as every Zod object here is. */
export type ProjectCloudflare = z.output<typeof ProjectCloudflare>;

/**
 * Read and validate the root config's `cloudflare` declaration.
 *
 * Parsed rather than cast, on {@link loadWorkerDomains}'s argument and one more of its own: `accountName`
 * becomes a **file name** in the config directory, which sits outside every checkout — so
 * `ensureScaffoldPath` and the atomic writer, the two things that guard a path inside a project, never
 * see it. {@link CloudflareAccountName} is the gate, and this is where a project's config meets it.
 *
 * Absent is not an error; it is the ordinary state of a machine with one Cloudflare account.
 */
export function loadProjectCloudflare(config: ProjectConfig): ProjectCloudflare | undefined {
  if (config.cloudflare === undefined || config.cloudflare === null) return undefined;
  const parsed = ProjectCloudflare.safeParse(config.cloudflare);
  if (!parsed.success) {
    // The schema's own sentences are promoted into `message` rather than left in `issues`, because the
    // CLI's error renderer prints `message` and `action` and nothing else — and the whole point of the
    // rule living at the schema is that its refusal names the config and the value wherever it surfaces.
    throw fromZodError(parsed.error, {
      message: `The \`cloudflare\` block in pithy.config.ts is not valid. ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
      action:
        "Fix `cloudflare` in the root pithy.config.ts. It takes `accountName` (a bare token selecting <config>/cloudflare.<name>.json) and `accountId` (the account the project belongs to).",
    });
  }
  return parsed.data;
}

/**
 * Read and validate the root config's `environments` declaration — **the project's environment set, in
 * one place, for every command that iterates environments** (#241).
 *
 * Before this, nothing said. The set existed only as `env.<name>` stanzas in each Worker's
 * `wrangler.jsonc` — per Worker, so two Workers could disagree with nobody reconciling them — while
 * `ManagedEnvironment` held a closed enum of two and `seed.productionEnvironments` invited a project to
 * name a third. An adopter adding `env.live` got a working `pithy migrate --env live` and a
 * `pithy secrets provision` that skipped it in silence.
 *
 * Absent is not an error: it is the ordinary state of a project that runs staging and prod, and it answers
 * {@link DEFAULT_ENVIRONMENTS} — the pair the scaffold hardcoded — so nothing about an existing project
 * changes until it says otherwise.
 *
 * **Validated on every load, not at the first provision.** An environment name reaches Cloudflare resource
 * names verbatim and a provisioned project cannot be renamed, so the one place that can still say no is
 * before any command has acted on it.
 */
export function loadProjectEnvironments(config: ProjectConfig): DeclaredEnvironments {
  if (config.environments === undefined || config.environments === null) return [...DEFAULT_ENVIRONMENTS];
  const parsed = DeclaredEnvironments.safeParse(config.environments);
  if (!parsed.success) {
    // The schema's own sentences are promoted into `message`, as the `cloudflare` block's are, because the
    // CLI's error renderer prints `message` and `action` and nothing else.
    throw fromZodError(parsed.error, {
      message: `The \`environments\` declaration in pithy.config.ts is not valid. ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
      action: `Fix \`environments\` in the root pithy.config.ts. It is a list of deployed environment names, least-production first — e.g. ${JSON.stringify([...DEFAULT_ENVIRONMENTS])}. Changing it does not rename anything already provisioned.`,
    });
  }
  return parsed.data;
}

/**
 * The environments a project has, loaded from its root config — the counterpart to
 * {@link projectCloudflareAccount}, for a command that has a directory rather than a loaded config.
 */
export async function projectEnvironments(projectDir: string): Promise<DeclaredEnvironments> {
  return loadProjectEnvironments(await loadProject(projectDir));
}

/**
 * One Worker's `apps/<name>/pithy.config.ts`: what *that* Worker is made of. Capabilities are per-Worker
 * because everything they drive is per-Worker — the composed route tree (`createEntrypoint`), the
 * `requiredBindings` written into that Worker's `wrangler.jsonc`, and Durable Object class migrations, which
 * register a class against a specific script. A Worker that only needs KV composes only what it declares.
 *
 * Workers share a resource by declaring the **same binding name**: feature resource names are derived from
 * `(project, issue, slug, binding, kind)` with no Worker segment, so two Workers that both declare `DB` are
 * backed by one D1, and a Worker wanting its own declares a different binding (e.g. `COLLAB_DB`).
 */
export interface WorkerConfig {
  /** Library capabilities this Worker composes, in order. `pithy add --worker <name>` registers them here. */
  capabilities: Capability[];
  /** This Worker's own app capability, composed last. */
  app?: Capability;
  /**
   * Where this Worker answers, per environment — the one declaration `routes`, `vars.BASE_URL`, and every
   * command that needs an address are derived from. Optional: a project without a domain yet is
   * legitimate, and adding one later is a config edit plus a deploy.
   *
   * Validated through {@link WorkerDomains} by {@link loadWorkerDomains} rather than trusted off the
   * import, because this file is the adopter's own TypeScript and nothing else checks it.
   */
  domains?: unknown;
}

/**
 * Read and validate a Worker's `domains` declaration.
 *
 * Parsed rather than cast: `pithy.config.ts` is the adopter's own module, `loadWorkerConfig` imports it
 * live, and duck-typing is the only other gate on it — so an unvalidated `domains` would reach the
 * wrangler generator as whatever they typed. A malformed declaration must fail with the field named,
 * not produce a `routes` entry Cloudflare rejects at deploy.
 *
 * Absent is not an error; it is the ordinary state of a project that has not wired a domain yet.
 */
export function loadWorkerDomains(config: WorkerConfig): WorkerDomains | undefined {
  if (config.domains === undefined || config.domains === null) return undefined;
  const parsed = WorkerDomains.safeParse(config.domains);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "This Worker's `domains` declaration is not valid.",
      action: "Fix `domains` in the Worker's pithy.config.ts. Each entry is `{ pattern, zone }` — bare hostnames.",
    });
  }
  return parsed.data;
}

function isWorkerConfig(value: unknown): value is WorkerConfig {
  return typeof value === "object" && value !== null && Array.isArray((value as WorkerConfig).capabilities);
}

function isProjectConfig(value: unknown): value is ProjectConfig {
  return typeof value === "object" && value !== null;
}

/**
 * Why a `pithy.config.ts` would not import. Three causes an adopter fixes three different ways, plus the
 * honest fourth: the classifier does not recognize this one and will not invent a remedy for it.
 */
export type ConfigLoadFailureKind = "unresolved-import" | "parse-error" | "threw-on-load" | "unknown";

/** A classified config-load failure: what went wrong, and the one sentence that fits it. */
export interface ConfigLoadFailure {
  /** Which of the four causes this is. */
  kind: ConfigLoadFailureKind;
  /** The `action` line for the refusal — chosen from the failure, never asserted over it. */
  action: string;
}

/**
 * The message, de-colored, for this classifier's own pattern tests — never for output.
 *
 * What may be *said* is core's {@link safeReason}, and only core's: the filter that decides whether a
 * runtime's string is fit to show lived here, in the capability loaders, and in the vite plugin, in three
 * near-verbatim copies, and the hole #223 found in it had to be closed in all three (#228). What stays
 * here is the policy — which causes this classifier recognizes, and what it says about each.
 */
function rawMessage(cause: unknown): string {
  return causeMessage(cause) ?? "";
}

function isUnresolvedImport(cause: unknown): boolean {
  const code = prop(cause, "code");
  if (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
    code === "ERR_UNSUPPORTED_DIR_IMPORT"
  ) {
    return true;
  }
  if (prop(cause, "name") === "ResolveMessage") return true;
  return /Cannot find (?:package|module) |Failed to resolve (?:import|module)|Failed to load url /.test(
    rawMessage(cause),
  );
}

function isParseError(cause: unknown): boolean {
  const name = prop(cause, "name");
  if (name === "SyntaxError" || name === "BuildMessage") return true;
  if (prop(cause, "code") === "PARSE_ERROR") return true;
  // Bun's build wrapper with its diagnostics already dropped — the shape every caller after the first
  // sees, and the one `pithy doctor` renders. It proves a build produced diagnostics, so it is a parse
  // error with no reason and no position rather than a config that threw. See core's `cause.ts`.
  if (isBuildFailureWrapper(cause)) return true;
  return /Transform failed|\[PARSE_ERROR]|Parse (?:error|failure)|Unexpected (?:token|end of input)/.test(
    rawMessage(cause),
  );
}

/**
 * Choose the refusal's `action` **from** the failure rather than asserting one over it (#207).
 *
 * A `pithy.config.ts` that will not import used to get one sentence whatever went wrong: *install the
 * project's dependencies, then check the config for errors*. For a missing dependency that is right. For
 * a stray brace it is confidently wrong, and being confidently wrong is worse than saying nothing —
 * an adopter runs `bun install`, nothing changes, and the parser's own message, which would have told
 * them, was captured into `detail` and discarded one frame up. That is #172 recurring: a config that
 * would not load naming the wrong cause, diagnosed wrong twice before anyone traced the import edge.
 *
 * So each cause gets the sentence that fits it, and the fourth gets none:
 *
 * - **unresolved-import** — the specifier is named, and `bun install` is right *here*, where it was earned.
 * - **parse-error** — the parser's reason and position. It says installing will not help, because the
 *   adopter has read the opposite for as long as this refusal has existed.
 * - **threw-on-load** — the config's own error, which is neither of the above.
 * - **unknown** — no remedy. A wrong action is worse than no action, because it is followed.
 *
 * Exported because the runtime that ships (`bin` runs on Bun, whose `ResolveMessage`/`BuildMessage` are
 * their own shapes) is not the runtime the suite runs on. Tested directly, it is tested for both.
 *
 * @param wrapped whatever the `try` caught, wrapper and all. {@link rootCause} opens it first — see #223:
 *   Bun wraps two or more build diagnostics in an `AggregateError`, and a stray brace cascades, so the
 *   wrapped shape is the *common* one. #207 fixed the bare case and this one classified worse than it.
 */
export function classifyConfigLoadFailure(wrapped: unknown): ConfigLoadFailure {
  // Bun hands `import()` failures over inside an `AggregateError`. Classify what is inside it.
  const cause = rootCause(wrapped);

  if (isUnresolvedImport(cause)) {
    const specifier = unresolvedSpecifier(cause);
    return {
      kind: "unresolved-import",
      action: specifier
        ? `Nothing resolves "${specifier}". Install the project's dependencies (bun install), or correct that import.`
        : "An import in the config does not resolve. Install the project's dependencies (bun install), then check its imports.",
    };
  }

  if (isParseError(cause)) {
    // Both of these can answer "nothing" — and one of the reasons they can is Bun's build wrapper, whose
    // whole message is a count and a path. That suppression is core's, once, rather than written out here
    // and in two other classifiers that each had to be found and patched (#223, #228).
    const reason = safeReason(cause);
    const at = failurePosition(cause);
    const where = at ? ` Line ${at.line}, column ${at.column}.` : "";
    return {
      kind: "parse-error",
      action: `The config does not parse${reason ? `: ${reason}` : ""}.${where} Fix the file — installing dependencies will not help.`,
    };
  }

  // Anything that carries a message, whether or not it extends `Error` — the config's own throw.
  if (causeMessage(cause) !== undefined) {
    const reason = safeReason(cause);
    return {
      kind: "threw-on-load",
      action: reason
        ? `The config threw while loading: ${reason}. Fix that in the config.`
        : "The config threw while loading. Run the file directly to see what it throws.",
    };
  }

  return { kind: "unknown", action: "Check pithy.config.ts. Run the file directly to see how it fails." };
}

/**
 * Import a config the current process has **just written**, and get what is on disk rather than what was
 * imported before the write.
 *
 * A module cache keyed on the path is correct almost everywhere and wrong in exactly one place: a command
 * that edits a `pithy.config.ts` and then has to read the result. `pithy add` is that command — it
 * resolves the target Worker (importing its config) before wiring, and its closing migrate imports the
 * config again to build the registry. The second import returned the *pre-wiring* module, so the registry
 * never contained the capability that had just been added and `add` applied none of its migrations while
 * reporting a clean run. `pithy add auth` left a Worker that booted and answered 500 on every auth route,
 * because the tables were not there (#273).
 *
 * **Only a different file busts it.** Measured on Bun 1.3: a `?t=…` query on the file URL does not, and
 * neither does the same file reached by a differently-spelled path. So this imports a copy, beside the
 * original — where the config's own relative imports and `import.meta.dirname` still resolve to the same
 * directory — and removes it. Dot-prefixed and uniquely named, so a crashed run leaves nothing a tool
 * collects and two concurrent runs cannot collide.
 */
async function importFreshCopy(path: string): Promise<{ default?: unknown }> {
  const copy = join(dirname(path), `.pithy.reload.${randomUUID()}.ts`);
  await copyFile(path, copy);
  try {
    return (await import(pathToFileURL(copy).href)) as { default?: unknown };
  } finally {
    await rm(copy, { force: true });
  }
}

/**
 * Import a `pithy.config.ts` and return its default export, with an error that names its own cause.
 *
 * `fresh` is for a caller that has written the file in this process — see {@link importFreshCopy}. Every
 * other caller takes the cache, because a config imported twice in one command should be one module.
 */
async function importConfig(path: string, missing: () => never, fresh = false): Promise<unknown> {
  try {
    await access(path);
  } catch {
    missing();
  }

  let module: { default?: unknown };
  try {
    module = fresh ? await importFreshCopy(path) : ((await import(pathToFileURL(path).href)) as { default?: unknown });
  } catch (cause) {
    // The file is present but would not import. Which of the three ways it failed decides what to tell
    // the adopter — see {@link classifyConfigLoadFailure}. The raw cause still goes to `detail` and stops
    // there: the CLI renderer prints `message` and `action` only, and the HTTP codec strips `detail`.
    // That boundary is unchanged. What changed is that the part of the cause an adopter can act on now
    // reaches them through `action`, in a form that carries no path, no source line, and no stack.
    const { kind, action } = classifyConfigLoadFailure(cause);
    throw new InternalError({
      message: `Could not load ${path}.`,
      action,
      detail: `${kind}: ${causeMessage(cause) ?? String(cause)}`,
    });
  }
  return module.default;
}

/** Options for {@link loadWorkerConfig}. */
export interface LoadWorkerConfigOptions {
  /**
   * Re-read the file rather than take the module cache. **Only for a caller that has written this config
   * in this process** — `pithy add`'s closing migrate is the one that must, and the one whose absence of
   * it meant a capability's migrations silently never ran (see `importFreshCopy`).
   */
  fresh?: boolean;
}

/**
 * Load one Worker's `apps/<name>/pithy.config.ts` — the capabilities that Worker composes. Imported live
 * (the config is code), so this runs under a TS-capable runtime; Phase 0 ships the bin on Bun.
 */
export async function loadWorkerConfig(workerDir: string, options?: LoadWorkerConfigOptions): Promise<WorkerConfig> {
  const path = join(workerDir, "pithy.config.ts");
  const value = await importConfig(
    path,
    () => {
      throw new NotFoundError({
        message: `No pithy.config.ts in ${workerDir}.`,
        action: "Every worker under apps/ needs one. pithy worker add creates it.",
      });
    },
    options?.fresh === true,
  );
  if (!isWorkerConfig(value)) {
    throw new InternalError({
      message: `${path} doesn't default-export a worker config.`,
      action: "Export default { capabilities, app }.",
    });
  }
  return value;
}

/**
 * Load the **root** `pithy.config.ts` — the project's identity and policy. Capabilities are not here; they
 * live per Worker ({@link loadWorkerConfig}).
 */
export async function loadProject(projectDir: string): Promise<ProjectConfig> {
  const path = join(projectDir, "pithy.config.ts");
  const value = await importConfig(path, () => {
    throw new NotFoundError({
      message: "No pithy.config.ts here.",
      action: "Run from a Pithy project. pithy init creates one.",
    });
  });
  if (!isProjectConfig(value)) {
    throw new InternalError({
      message: "pithy.config.ts doesn't default-export a config.",
      action: "Export default { name }.",
    });
  }
  // Validated on every load, so a name that would not survive `CloudflareAccountName` refuses the
  // command that read the config rather than whichever later call happened to build a path out of it.
  // The value is *returned*, never published: an ambient account is what made six call sites resolve
  // credentials before anything had established which account they were for.
  loadProjectCloudflare(value);
  // Same rule, same reason: an environment name reaches Cloudflare resource names verbatim, and a
  // provisioned project cannot be renamed — so a declaration that would not survive the naming rule
  // refuses the command that read the config, rather than the later call that composed a name from it.
  loadProjectEnvironments(value);
  return value;
}

/**
 * The Cloudflare account a project belongs to, loaded from its root config — **the one way a command
 * gets an account to resolve credentials for.**
 *
 * `cloudflareEnv` takes the account as an argument rather than reading an ambient, and this is what
 * every caller passes it. Loading the project is the only way to learn the answer, so the two are one
 * call here: a command cannot resolve credentials "before" the project any more than it can call this
 * function without awaiting it.
 *
 * Throws what {@link loadProject} throws when there is no config here — a command that is inside a
 * project and cannot read its config has a worse problem than which account it is for. A caller that
 * legitimately has no project (`pithy init` before the scaffold exists) passes `null` instead of asking.
 */
export async function projectCloudflareAccount(projectDir: string): Promise<ProjectCloudflare | null> {
  return loadProjectCloudflare(await loadProject(projectDir)) ?? null;
}

/** Every capability one Worker composes, in order: libraries first, its app last. */
export function allCapabilities(config: WorkerConfig): Capability[] {
  return config.app ? [...config.capabilities, config.app] : [...config.capabilities];
}

/**
 * The project name, leniently guessed. Prefers the explicit `pithy.config.ts` `name`, then the first
 * discovered worker's `wrangler.jsonc` name, then the project directory's own name — always normalized
 * to hyphenated-lowercase. The fallbacks are **not stable**: `discoverWorkers` sorts alphabetically, so
 * adding an app that sorts earlier changes the guess, and the directory basename differs between a
 * worktree checkout and a normal clone. Fine for a cosmetic default; never use this where the name
 * feeds a naming convention another command must reproduce later — use {@link requireProjectName} there.
 */
export async function resolveProjectName(config: ProjectConfig, projectDir: string): Promise<string> {
  if (config.name) return kebab(config.name);
  const [worker] = await discoverWorkers(projectDir);
  if (worker) return kebab(worker.name);
  return kebab(basename(projectDir));
}

/**
 * The project name for the `pithy feature` resource-naming convention — the FIRST SEGMENT of every
 * Cloudflare resource name (`<project>-f<issue>-<slug>-<binding>-<kind>`) and the only key
 * `pithy feature destroy` has to find and delete them again. Unlike {@link resolveProjectName}, this
 * never guesses: it requires an explicit `pithy.config.ts` `name`, because any fallback that can differ
 * between machines or checkouts (an alphabetically-first worker, a worktree's directory basename) would
 * make teardown recompute names that match nothing, delete nothing, and exit 0 — a silent resource leak.
 * Throws an actionable `ValidationError` when `name` is absent.
 *
 * It also holds the name to `assertValidProjectName`, and that is the *second* half of the same guard.
 * `scaffoldProject` keeps a bad name from being created; this keeps an already-created one from getting
 * anywhere. Cloudflare's namespaces disagree about what a legal project segment is — D1, KV, and R2 take
 * a digit-leading name, Worker scripts and Workflows refuse it — so without this check `pithy add` and
 * `pithy migrate` provision real resources and only the first host-worker deploy fails, leaving a
 * half-provisioned project whose only documented fix orphans everything already created. Every command
 * resolves the project through here, so every command refuses on the first one instead.
 */
export function requireProjectName(config: ProjectConfig): string {
  if (!config.name) {
    throw new ValidationError({
      message: "pithy.config.ts has no `name`.",
      action:
        "Set `name` in pithy.config.ts. Every feature resource name — and pithy feature destroy's ability to find and delete it later — derives from this name, so it must stay stable across machines and checkouts.",
    });
  }
  assertValidProjectName(config.name);
  // `kebab` is core's, imported rather than reimplemented: a project name has to normalize identically
  // in every command that composes a resource name, and a second copy here would drift.
  return kebab(config.name);
}
